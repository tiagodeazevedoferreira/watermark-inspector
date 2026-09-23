/* ============================================================
   Watermark Inspector — Popup
   ============================================================ */

const log = document.getElementById('log');

function logMsg(msg) {
  log.textContent = msg;
}

/* ============================================================
   COLETA TUDO + abre página de inpainting
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

      function isFoto(url) {
        if (!url) return false;
        if (url.startsWith('data:')) return false;
        if (url.includes('/logo')) return false;
        if (url.includes('/icon')) return false;
        if (url.includes('avatar')) return false;
        if (url.includes('favicon')) return false;
        return true;
      }

      function collect() {
        let added = 0;
        document.querySelectorAll('img').forEach(img => {
          ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-lazy'].forEach(attr => {
            const v = img.getAttribute(attr);
            if (!v || !isFoto(v)) return;
            try {
              const u = new URL(v, location.href).href;
              if (!seen.has(u)) { seen.add(u); urls.push(u); added++; }
            } catch {}
          });

          const srcset = img.getAttribute('srcset');
          if (srcset) {
            srcset.split(',').forEach(part => {
              const u = part.trim().split(/\s+/)[0];
              if (!u || !isFoto(u)) return;
              try {
                const full = new URL(u, location.href).href;
                if (!seen.has(full)) { seen.add(full); urls.push(full); added++; }
              } catch {}
            });
          }
        });
        return added;
      }

      collect();
      const initial = urls.length;

      let noNewCount = 0;
      let lastTotal = urls.length;
      let iterations = 0;

      while (noNewCount < 5 && iterations < 200) {
        iterations++;
        window.scrollTo(0, document.documentElement.scrollHeight);
        document.documentElement.scrollTop = document.documentElement.scrollHeight;
        if (document.body) document.body.scrollTop = document.body.scrollHeight;

        await sleep(1500);

        document.querySelectorAll('*').forEach(el => {
          if (el.scrollHeight > el.clientHeight + 100 && el.clientHeight > 200) {
            el.scrollTop = el.scrollHeight;
          }
        });

        await sleep(500);

        const added = collect();
        const total = urls.length;

        if (total === lastTotal && added === 0) noNewCount++;
        else noNewCount = 0;
        lastTotal = total;
      }

      window.scrollTo(0, 0);
      return { urls, initial, total: urls.length, iterations };
    }
  });

  const { urls, initial, total } = results[0].result;

  if (urls.length === 0) {
    logMsg('❌ Nenhuma imagem encontrada.');
    return;
  }

  logMsg(`✅ ${total} fotos coletadas.\n\nSalvando e abrindo processador...`);

  // Salva no storage
  await chrome.storage.local.set({ pendingUrls: urls });

  // Abre a nova aba de inpainting
  await chrome.tabs.create({
    url: chrome.runtime.getURL('inpaint.html'),
  });

  logMsg(`✅ ${total} fotos enviadas.\n\nA aba de inpainting foi aberta.`);
});

/* ============================================================
   Extrair só o visível
   ============================================================ */
document.getElementById('extractImages').addEventListener('click', async () => {
  logMsg('Buscando imagens...');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const seen = new Set();
      const urls = [];

      function isFoto(url) {
        if (!url) return false;
        if (url.startsWith('data:')) return false;
        if (url.includes('/logo')) return false;
        if (url.includes('/icon')) return false;
        if (url.includes('avatar')) return false;
        if (url.includes('favicon')) return false;
        return true;
      }

      document.querySelectorAll('img').forEach(img => {
        ['src', 'data-src', 'data-original', 'data-lazy-src'].forEach(attr => {
          const v = img.getAttribute(attr);
          if (!v || !isFoto(v)) return;
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

  logMsg(`✅ ${urls.length} fotos. Baixando...`);

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
        await sleep(500);
      }
    }
  });

  logMsg(`✅ ${urls.length} downloads iniciados.`);
});

/* ============================================================
   Remover overlays
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
