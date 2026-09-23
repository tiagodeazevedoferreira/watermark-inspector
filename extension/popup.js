const log = document.getElementById('log');

function logMsg(msg) {
  log.textContent = msg;
}

/* ============================================================
   COLETA TUDO — rola a página e espera imagens carregarem
   ============================================================ */
document.getElementById('collectAll').addEventListener('click', async () => {
  logMsg('Iniciando coleta com scroll...\nIsso pode demorar 30s a 2 minutos.');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // Injeta script que rola e coleta
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
        if (newHeight === lastHeight) {
          stuckCount++;
        } else {
          stuckCount = 0;
        }
        lastHeight = newHeight;

        // Se clicar num botão "carregar mais", descomente abaixo
        // const moreBtn = [...document.querySelectorAll('button')].find(b =>
        //   /carregar|mais|ver mais|load more/i.test(b.textContent));
        // if (moreBtn) moreBtn.click();
      }

      // Volta ao topo
      window.scrollTo(0, 0);

      return { urls, initial, total: urls.length };
    }
  });

  const { urls, initial, total } = results[0].result;

  logMsg(`Inicial: ${initial} imagens\nApós scroll: ${total} imagens\n\nBaixando...`);

  await downloadAll(tab, urls);
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
  await downloadAll(tab, urls);
});

/* ============================================================
   Baixar todas as imagens (dentro da página)
   ============================================================ */
async function downloadAll(tab, urls) {
  // Abre nova aba para fazer os downloads (não trava a página principal)
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [urls],
    func: async (urls) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));

      for (let i = 0; i < urls.length; i++) {
        const url = urls[i];

        try {
          // Baixa como blob para preservar nome
          const res = await fetch(url, { credentials: 'include' });
          const blob = await res.blob();

          const ext = (url.match(/\.(jpe?g|png|webp|gif)/i) || ['', 'jpg'])[1];
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `foto-${String(i + 1).padStart(3, '0')}.${ext}`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);

          setTimeout(() => URL.revokeObjectURL(a.href), 10000);

          // 400ms entre downloads evita bloqueio do Chrome
          await sleep(400);
        } catch (e) {
          console.warn('Falha em', url, e);
        }
      }
    }
  });

  logMsg(`✅ ${urls.length} downloads iniciados.\n\nVerifique a pasta Downloads.`);
}

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
