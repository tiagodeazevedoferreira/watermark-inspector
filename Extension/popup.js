/* ============================================================
   Watermark Inspector — Popup (versão de extração)
   Coleta todas as imagens com scroll automático e baixa.
   ============================================================ */

const log = document.getElementById('log');

function logMsg(msg) {
  log.textContent = msg;
}

/* ============================================================
   COLETA TUDO — rola a página e coleta todas as URLs
   ============================================================ */
document.getElementById('collectAll').addEventListener('click', async () => {
  logMsg('Coletando imagens...\nIsso pode demorar 30s a 2 minutos.');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const seen = new Set();
      const urls = [];

      function collect() {
        let added = 0;
        document.querySelectorAll('img').forEach(img => {
          ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-lazy'].forEach(attr => {
            const v = img.getAttribute(attr);
            if (!v || v.startsWith('data:')) return;
            try {
              const u = new URL(v, location.href).href;
              if (!seen.has(u)) { seen.add(u); urls.push(u); added++; }
            } catch {}
          });

          const srcset = img.getAttribute('srcset');
          if (srcset) {
            srcset.split(',').forEach(part => {
              const u = part.trim().split(/\s+/)[0];
              if (!u || u.startsWith('data:')) return;
              try {
                const full = new URL(u, location.href).href;
                if (!seen.has(full)) { seen.add(full); urls.push(full); added++; }
              } catch {}
            });
          }
        });
        return added;
      }

      // Coleta inicial
      collect();
      const initial = urls.length;

      // Rola até o fim
      let lastHeight = 0;
      let stuckCount = 0;

      while (stuckCount < 3) {
        window.scrollTo(0, document.body.scrollHeight);
        await sleep(800);
        collect();

        const newHeight = document.body.scrollHeight;
        if (newHeight === lastHeight) stuckCount++;
        else stuckCount = 0;
        lastHeight = newHeight;
      }

      window.scrollTo(0, 0);

      return { urls, initial, total: urls.length };
    }
  });

  const { urls, initial, total } = results[0].result;

  logMsg(`Inicial: ${initial} imagens\nApós scroll: ${total} imagens\n\nBaixando...`);

  if (urls.length === 0) {
    logMsg('❌ Nenhuma imagem encontrada.');
    return;
  }

  // Baixa todas
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [urls],
    func: async (urls) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      for (let i = 0; i < urls.length; i++) {
        const a = document.createElement('a');
        a.href = urls[i];
        a.download = `foto-${String(i + 1).padStart(3, '0')}.jpg`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        await sleep(400);
      }
    }
  });

  logMsg(`✅ ${total} imagens baixadas.\n\nVerifique a pasta Downloads.`);
});

/* ============================================================
   Extrair só o visível
   ============================================================ */
document.getElementById('extractImages').addEventListener('click', async () => {
  logMsg('Buscando imagens visíveis...');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const imgs = [...document.querySelectorAll('img')];
      const seen = new Set();
      const urls = [];
      imgs.forEach(img => {
        ['src', 'data-src', 'data-original', 'data-lazy-src'].forEach(attr => {
          const v = img.getAttribute(attr);
          if (!v || v.startsWith('data:')) return;
          try {
            const u = new URL(v, location.href).href;
            if (!seen.has(u)) { seen.add(u); urls.push(u); }
          } catch {}
        });
      });
      return urls;
    }
  });

  const urls = results[0].result || [];
  if (urls.length === 0) return logMsg('❌ Nenhuma imagem.');
  logMsg(`✅ ${urls.length} imagens. Baixando...`);

  for (let i = 0; i < urls.length; i++) {
    const a = document.createElement('a');
    a.href = urls[i];
    a.download = `foto-${String(i + 1).padStart(3, '0')}.jpg`;
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    await new Promise(r => setTimeout(r, 300));
  }

  logMsg(`✅ ${urls.length} downloads iniciados.`);
});