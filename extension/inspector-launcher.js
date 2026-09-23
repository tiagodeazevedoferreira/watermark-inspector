document.getElementById('inspectPage').addEventListener('click', async () => {
  try {
    logMsg('🔬 Preparando captura profunda de rede...');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('Aba ativa não encontrada.');

    const tabId = tab.id;
    const started = await chrome.runtime.sendMessage({ type: 'startNetworkCapture', tabId });
    if (!started?.ok) throw new Error(started?.error || 'Não foi possível iniciar a captura de rede.');

    await chrome.tabs.reload(tabId);
    await waitForLoad(tabId, 12000);

    logMsg('🔎 Rede capturada. Analisando DOM, CSS, SVG e recursos...');
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      files: ['inspector-content.js']
    });
    const report = results?.[0]?.result;
    if (!report) throw new Error('Não foi possível obter o diagnóstico da página.');

    const network = await chrome.runtime.sendMessage({ type: 'stopNetworkCapture', tabId });
    report.network = network?.requests || [];
    enrichWithNetwork(report);

    await chrome.storage.local.set({
      inspection: report,
      pendingUrls: report.images.map(i => i.urls?.[0]).filter(Boolean)
    });

    await chrome.tabs.create({ url: chrome.runtime.getURL('inspector.html') });
    logMsg(`✅ Diagnóstico criado: ${report.counts.domImages} imagens, ${report.counts.uniqueCandidates} candidatos, ${report.network.length} requisições de rede.`);
  } catch (err) {
    console.error(err);
    logMsg('❌ Falha ao investigar: ' + err.message);
  }
});

function waitForLoad(tabId, timeoutMs) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
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

function enrichWithNetwork(report) {
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
  const imageUrls = [...new Set(imageRequests.map(r => r.url).filter(Boolean))];

  for (const url of imageUrls) {
    if (!report.candidates.some(c => c.url === url)) {
      report.candidates.push({
        url,
        sources: ['network.image'],
        confidence: 94
      });
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

  // Preserve a compact, searchable URL index in the report.
  report.networkUrlIndex = networkUrls.slice(-5000);
}
