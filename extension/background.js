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
