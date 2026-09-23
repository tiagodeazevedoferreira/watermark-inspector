document.getElementById('inspectPage').addEventListener('click', async () => {
  try {
    logMsg('🔬 Inspecionando DOM, CSS, SVG e recursos...');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('Aba ativa não encontrada.');
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['inspector-content.js']
    });
    const report = results?.[0]?.result;
    if (!report) throw new Error('Não foi possível obter o diagnóstico da página.');
    await chrome.storage.local.set({ inspection: report, pendingUrls: report.images.map(i => i.urls?.[0]).filter(Boolean) });
    await chrome.tabs.create({ url: chrome.runtime.getURL('inspector.html') });
    logMsg(`✅ Diagnóstico criado: ${report.counts.domImages} imagens, ${report.counts.uniqueCandidates} candidatos, ${report.counts.possibleOverlays} possíveis overlays.`);
  } catch (err) {
    console.error(err);
    logMsg('❌ Falha ao investigar: ' + err.message);
  }
});