document.getElementById('inspectPage').addEventListener('click', async () => {
  try {
    logMsg('🔬 Iniciando investigação profunda. A página será recarregada para capturar a rede...');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('Aba ativa não encontrada.');
    const result = await chrome.runtime.sendMessage({ type: 'deepInspect', tabId: tab.id });
    if (!result?.ok) throw new Error(result?.error || 'Falha na investigação.');
    logMsg(`✅ Diagnóstico concluído: ${result.counts.domImages} imagens, ${result.counts.uniqueCandidates} candidatos, ${result.networkSummary?.total || 0} requisições de rede.`);
  } catch (err) {
    console.error(err);
    logMsg('❌ Falha ao investigar: ' + err.message);
  }
});
