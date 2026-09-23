const log = document.getElementById('log');

function logMsg(msg) {
  log.textContent = msg;
}

/* ============================================================
   COLETA TUDO — rola a página, coleta URLs, abre inpainting
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
        document.querySelectorAll('img').forEach(img => {
          ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-lazy'].forEach(attr => {
            const v = img.getAttribute(attr);
            if (!v || v.startsWith('data:')) return;
            try {
              const u = new URL(v, location.href).href;
              if (!seen.has(u)) { seen.add(u); urls.push(u); }
            } catch {}
          });

          const srcset = img.getAttribute('srcset');
          if (srcset) {
            srcset.split(',').forEach(part => {
              const u = part.trim().split(/\s+/)[0];
              if (!u || u.startsWith('data:')) return;
              try {
                const full = new URL(u, location.href).href;
                if (!seen.has(full)) { seen.add(full); urls.push(full); }
              } catch {}
            });
          }
        });
      }

      collect();
      const initial = urls.length;

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

  if (urls.length === 0) {
    logMsg('❌ Nenhuma imagem encontrada.');
    return;
  }

  logMsg(`✅ Coletadas ${total} imagens.\n\nSalvando e abrindo processador...`);

  // Salva no storage para a página de inpainting ler
  await chrome.storage.local.set({ pendingUrls: urls });

  // Abre a página de inpainting numa nova aba
  await chrome.tabs.create({
    url: chrome.runtime.getURL('inpaint.html'),
  });

  logMsg(`✅ ${total} imagens enviadas para processamento.\n\nA aba de inpainting foi aberta.`);
});

/* ============================================================
   Extrair só o visível (mantém como estava)
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
    a.download = `original-${i + 1}.jpg`;
    a.target = '_blank';
    a.click();
    await new Promise(r => setTimeout(r, 300));
  }

  logMsg(`✅ ${urls.length} downloads iniciados.`);
});

/* ============================================================
   Remover overlays (mantém como estava)
   ============================================================ */
document.getElementById('removeOverlays').addEventListener('click', () => run('normal'));
document.getElementById('removeAggressive').addEventListener('click', () => run('aggressive'));

async function run(mode) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [mode],
    func: (mode) => {
      const KEYWORDS = [
        'watermark', 'marca', 'marca-dagua', 'marca_dagua', 'water-mark',
        'overlay', 'protected', 'protection', 'logo-overlay', 'brand',
        'copyright', 'selo', 'stamp', 'anti-theft', 'nosave', 'no-save'
      ];
      function score(el) {
        const id = (el.id || '').toLowerCase();
        const cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
        const style = getComputedStyle(el);
        let s = 0;
        if (KEYWORDS.some(k => id.includes(k) || cls.includes(k))) s += 3;
        if (style.position === 'absolute' || style.position === 'fixed') s += 1;
        if (parseInt(style.zIndex, 10) > 10) s += 1;
        if (style.pointerEvents === 'none') s += 1;
        if (el.tagName === 'CANVAS') s += 1;
        return s;
      }
      const removed = [];
      const threshold = mode === 'aggressive' ? 2 : 3;
      document.querySelectorAll('body *').forEach(el => {
        if (el === document.body) return;
        if (score(el) >= threshold) {
          const isHuge = el.offsetWidth > window.innerWidth * 0.9 &&
                         el.offsetHeight > window.innerHeight * 0.9;
          if (isHuge && el.tagName !== 'CANVAS') return;
          el.style.setProperty('display', 'none', 'important');
          removed.push(el.tagName);
        }
      });
      return { removed: removed.slice(0, 20), total: removed.length };
    }
  });
  const r = results[0].result;
  logMsg(`✅ Removidos: ${r.total}`);
}
