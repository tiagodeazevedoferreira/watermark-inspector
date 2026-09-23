/* ============================================================
   Watermark Inspector — Popup
   Coleta imagens com scroll automático e baixa todas.
   ============================================================ */

const log = document.getElementById('log');

function logMsg(msg) {
  log.textContent = msg;
}

/* ============================================================
   COLETA TUDO — rola a página e coleta todas as URLs
   ============================================================ */
document.getElementById('collectAll').addEventListener('click', async () => {
  logMsg('Coletando imagens...\nIsso pode demorar 1-3 minutos.');

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

      // Rola até o fim, com múltiplas estratégias
      let noNewCount = 0;
      let lastTotal = urls.length;
      let iterations = 0;
      const MAX_ITERATIONS = 200;

      while (noNewCount < 5 && iterations < MAX_ITERATIONS) {
        iterations++;

        // Rolagem múltipla
        window.scrollTo(0, document.documentElement.scrollHeight);
        document.documentElement.scrollTop = document.documentElement.scrollHeight;
        if (document.body) document.body.scrollTop = document.body.scrollHeight;

        await sleep(1500);

        // Rola containers internos
        document.querySelectorAll('*').forEach(el => {
          if (el.scrollHeight > el.clientHeight + 100 && el.clientHeight > 200) {
            el.scrollTop = el.scrollHeight;
          }
        });

        await sleep(500);

        const added = collect();
        const total = urls.length;

        if (total === lastTotal && added === 0) {
          noNewCount++;
        } else {
          noNewCount = 0;
        }
        lastTotal = total;
      }

      window.scrollTo(0, 0);

      return { urls, initial, total: urls.length, iterations };
    }
  });

  const { urls, initial, total, iterations } = results[0].result;

  if (urls.length === 0) {
    logMsg('❌ Nenhuma imagem encontrada.');
    return;
  }

  logMsg(`✅ Inicial: ${initial} | Final: ${total}\nRolagens: ${iterations}\n\nBaixando...`);

  // Filtra logos e ícones
  const fotos = urls.filter(u => {
    if (u.includes('/logo')) return false;
    if (u.includes('/icon')) return false;
    if (u.includes('avatar')) return false;
    if (u.includes('favicon')) return false;
    return true;
  });

  // Baixa todas
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [fotos],
    func: async (urls) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      for (let i = 0; i < urls.length; i++) {
        const a = document.createElement('a');
        a.href = urls[i];
        a.download = `foto-${String(i + 1).padStart(3, '0')}.jpg`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        await sleep(500);
      }
    }
  });

  logMsg(`✅ ${fotos.length} downloads iniciados.\n\nVerifique a pasta Downloads.`);
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
