const log = document.getElementById('log');

function logMsg(msg) {
  log.textContent = msg;
}

/* ---------- Extrair imagens ---------- */
document.getElementById('extractImages').addEventListener('click', async () => {
  logMsg('Buscando imagens...');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const imgs = [...document.querySelectorAll('img')];
      const seen = new Set();
      const urls = [];

      imgs.forEach(img => {
        ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-lazy'].forEach(attr => {
          const v = img.getAttribute(attr);
          if (!v || v.startsWith('data:')) return;
          try {
            const u = new URL(v, location.href).href;
            if (!seen.has(u)) { seen.add(u); urls.push(u); }
          } catch {}
        });

        // srcset (pega a maior)
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

      return urls;
    }
  });

  const urls = results[0].result || [];

  if (urls.length === 0) {
    logMsg('❌ Nenhuma imagem encontrada.');
    return;
  }

  logMsg(`✅ Encontradas ${urls.length} imagens.\n\nBaixando...`);

  // Baixa cada uma
  for (let i = 0; i < urls.length; i++) {
    try {
      const a = document.createElement('a');
      a.href = urls[i];
      a.download = `imagem-${i + 1}.jpg`;
      a.target = '_blank';
      a.click();
      // Pequeno delay para não ser bloqueado
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.warn('Erro ao baixar', urls[i], e);
    }
  }

  logMsg(`✅ ${urls.length} imagens enviadas para download.`);
});

/* ---------- Remover overlays ---------- */
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
        const s = score(el);
        if (s >= threshold) {
          const isHuge = el.offsetWidth > window.innerWidth * 0.9 &&
                         el.offsetHeight > window.innerHeight * 0.9;
          if (isHuge && el.tagName !== 'CANVAS') return;
          el.style.setProperty('display', 'none', 'important');
          removed.push(el.tagName +
            (el.id ? '#' + el.id : '') +
            (el.className && typeof el.className === 'string' ?
              '.' + el.className.split(' ')[0] : ''));
        }
      });

      return { removed: removed.slice(0, 20), total: removed.length };
    }
  });

  const r = results[0].result;
  logMsg(`✅ Removidos: ${r.total}\n\n` +
    (r.removed.length ? r.removed.map(x => '• ' + x).join('\n') : '(nenhum)'));
}
