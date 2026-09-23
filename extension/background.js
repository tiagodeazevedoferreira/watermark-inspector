const captures = new Map();

function getCapture(tabId) {
  if (!captures.has(tabId)) captures.set(tabId, new Map());
  return captures.get(tabId);
}

function headerValue(headers, name) {
  const h = (headers || []).find(x => x.name && x.name.toLowerCase() === name);
  return h?.value || '';
}

function isInteresting(details) {
  return details.type === 'image' ||
    details.type === 'xmlhttprequest' ||
    details.type === 'main_frame' ||
    details.type === 'script' ||
    details.type === 'other' ||
    /(?:image|photo|foto|media|asset|original|watermark|marca|gallery|album|event|evento|api|graphql)/i.test(details.url);
}

chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (details.tabId < 0 || !isInteresting(details)) return;
  const c = getCapture(details.tabId);
  c.set(details.requestId, {
    requestId: details.requestId,
    url: details.url,
    method: details.method,
    type: details.type,
    initiator: details.initiator || '',
    timeStamp: details.timeStamp,
    status: 'started'
  });
}, { urls: ['<all_urls>'] });

chrome.webRequest.onBeforeSendHeaders.addListener((details) => {
  const c = captures.get(details.tabId);
  const item = c?.get(details.requestId);
  if (!item) return;
  item.referer = headerValue(details.requestHeaders, 'referer');
}, { urls: ['<all_urls>'] }, ['requestHeaders']);

chrome.webRequest.onHeadersReceived.addListener((details) => {
  const c = captures.get(details.tabId);
  const item = c?.get(details.requestId);
  if (!item) return;
  item.statusCode = details.statusCode;
  item.contentType = headerValue(details.responseHeaders, 'content-type');
  item.contentLength = headerValue(details.responseHeaders, 'content-length');
  item.cacheControl = headerValue(details.responseHeaders, 'cache-control');
  item.location = headerValue(details.responseHeaders, 'location');
  item.status = 'headers';
}, { urls: ['<all_urls>'] }, ['responseHeaders']);

chrome.webRequest.onCompleted.addListener((details) => {
  const c = captures.get(details.tabId);
  const item = c?.get(details.requestId);
  if (!item) return;
  item.statusCode = details.statusCode;
  item.fromCache = !!details.fromCache;
  item.status = 'completed';
}, { urls: ['<all_urls>'] });

chrome.webRequest.onErrorOccurred.addListener((details) => {
  const c = captures.get(details.tabId);
  const item = c?.get(details.requestId);
  if (!item) return;
  item.status = 'error';
  item.error = details.error || 'unknown';
}, { urls: ['<all_urls>'] });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !['startNetworkCapture', 'stopNetworkCapture', 'getNetworkCapture'].includes(msg.type)) return;

  const tabId = Number(msg.tabId ?? sender.tab?.id);
  if (!Number.isInteger(tabId) || tabId < 0) {
    sendResponse({ ok: false, error: 'tabId inválido' });
    return;
  }

  if (msg.type === 'startNetworkCapture') {
    captures.set(tabId, new Map());
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'stopNetworkCapture' || msg.type === 'getNetworkCapture') {
    const rows = [...(captures.get(tabId)?.values() || [])];
    sendResponse({
      ok: true,
      requests: rows.sort((a,b) => a.timeStamp - b.timeStamp).slice(-5000)
    });
    if (msg.type === 'stopNetworkCapture') captures.delete(tabId);
  }
});


async function deepInspect(tabId) {
  const started = await startCapture(tabId);
  if (!started.ok) throw new Error(started.error || 'Falha ao iniciar captura de rede.');

  await chrome.tabs.reload(tabId);
  await waitForComplete(tabId, 15000);

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    files: ['inspector-content.js']
  });
  const report = results?.[0]?.result;
  if (!report) throw new Error('Não foi possível obter o diagnóstico da página.');

  const network = await getAndStopCapture(tabId);
  report.network = network.requests || [];
  enrichReport(report);

  await chrome.storage.local.set({
    inspection: report,
    pendingUrls: report.images.map(i => i.urls?.[0]).filter(Boolean)
  });

  await chrome.tabs.create({ url: chrome.runtime.getURL('inspector.html') });
  return report;
}

function startCapture(tabId) {
  captures.set(tabId, new Map());
  return Promise.resolve({ok: true});
}

function getAndStopCapture(tabId) {
  const rows = [...(captures.get(tabId)?.values() || [])];
  captures.delete(tabId);
  return Promise.resolve({
    ok: true,
    requests: rows.sort((a,b) => a.timeStamp - b.timeStamp).slice(-5000)
  });
}

function waitForComplete(tabId, timeoutMs) {
  return new Promise(resolve => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      setTimeout(resolve, 2500);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function enrichReport(report) {
  const network = report.network || [];
  const imageRequests = network.filter(r =>
    r.type === 'image' ||
    /^(?:image\/|application\/octet-stream)/i.test(r.contentType || '') ||
    /\.(?:jpe?g|png|webp|gif|avif|bmp)(?:[?#]|$)/i.test(r.url || '')
  );
  const apiRequests = network.filter(r =>
    /xmlhttprequest|fetch/i.test(r.type || '') ||
    /(?:api|graphql|json|event|evento|gallery|album|photo|foto|image|media)/i.test(r.url || '')
  );
  const networkUrls = [...new Set(network.map(r => r.url).filter(Boolean))];
  for (const url of imageRequests.map(r => r.url)) {
    if (url && !report.candidates.some(c => c.url === url)) {
      report.candidates.push({url, sources:['network.image'], confidence:94});
    }
  }
  report.networkSummary = {
    total: network.length,
    imageRequests: imageRequests.length,
    apiLikeRequests: apiRequests.length,
    uniqueUrls: networkUrls.length
  };
  report.networkImages = imageRequests;
  report.networkApis = apiRequests.slice(0, 1000);
  report.networkUrlIndex = networkUrls.slice(-5000);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'deepInspect') return;
  const tabId = Number(msg.tabId ?? sender.tab?.id);
  if (!Number.isInteger(tabId) || tabId < 0) {
    sendResponse({ok:false, error:'tabId inválido'});
    return;
  }
  deepInspect(tabId)
    .then(report => sendResponse({
      ok:true,
      counts: report.counts,
      networkSummary: report.networkSummary
    }))
    .catch(err => sendResponse({ok:false, error:err.message}));
  return true;
});
