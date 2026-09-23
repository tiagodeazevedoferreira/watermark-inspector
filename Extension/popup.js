/* ============================================================
   Watermark Inspector — Popup
   ============================================================ */

const log = document.getElementById('log');

function logMsg(msg) {
  log.textContent = msg;
  console.log('[WM]', msg);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getFilename(url, index) {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    const last = pathname.split('/').filter(Boolean).pop() || '';
    const clean = last.split('?')[0].split('#')[0];

    if (clean && /\.[a-z0-9]{2,5}$/i.test(clean)) {
      return clean;
    }

    const type = (parsed.search.match(/[?&](?:format|fm)=([^&]+)/i) || [])[1];
    const ext = type && /^[a-z0-9]{2,5}$/i.test(type) ? type : 'jpg';
    return `foto-${String(index + 1).padStart(3, '0')}.${ext}`;
  } catch {
    return `foto-${String(index + 1).padStart(3, '0')}.jpg`;
  }
}

async function downloadUrls(urls) {
  let started = 0;
  let failed = 0;

  for (let i = 0; i < urls.length; i++) {
    try {
      await chrome.downloads.download({
        url: urls[i],
        filename: `watermark-inspector/${getFilename(urls[i], i)}`,
        conflictAction: 'uniquify',
        saveAs: false
      });
      started++;
    } catch (error) {
      failed++;
      console.warn('[WM] Falha ao baixar:', urls[i], error);
    }

    // Evita disparar centenas de downloads simultaneamente.
    await sleep(150);
  }

  return { started, failed };
}

console.log('[WM] popup.js carregado');

/* ============================================================
   COLETA TUDO
   ============================================================ */
document.getElementById('collectAll').addEventListener('click', async () => {
  console.log('[WM] botão collectAll clicado');
  logMsg('Coletando imagens... Aguarde 1-3 minutos.');

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });

    if (!tab?.id) {
      logMsg('❌ Não foi possível identificar a aba ativa.');
      return;
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const seen = new Set();
        const urls = [];

        function addUrl(value) {
          if (!value || value.startsWith('data:') || value.startsWith('blob:')) {
            return false;
          }

          try {
            const url = new URL(value, location.href).href;
            if (!/^https?:$/i.test(new URL(url).protocol)) return false;
            if (seen.has(url)) return false;

            seen.add(url);
            urls.push(url);
            return true;
          } catch {
            return false;
          }
        }

        function collectSrcset(value) {
          if (!value) return;

          value.split(',').forEach(part => {
            const candidate = part.trim().split(/\s+/)[0];
            addUrl(candidate);
          });
        }

        function collect() {
          const before = urls.length;

          // Imagens normais, lazy-load e <picture>/<source>.
          document.querySelectorAll('img, source').forEach(element => {
            [
              'src',
              'data-src',
              'data-original',
              'data-lazy-src',
              'data-lazy',
              'data-original-src',
              'data-image',
              'data-image-src'
            ].forEach(attr => addUrl(element.getAttribute(attr)));

            collectSrcset(element.getAttribute('srcset'));
            collectSrcset(element.getAttribute('data-srcset'));
          });

          // Imagens definidas como background-image no CSS inline.
          document.querySelectorAll('[style*="background-image"]').forEach(element => {
            const style = element.getAttribute('style') || '';
            const matches = style.matchAll(
              /background-image\\s*:\\s*url\\((['"]?)(.*?)\\1\\)/gi
            );

            for (const match of matches) {
              addUrl(match[2]);
            }
          });

          return urls.length - before;
        }

        collect();
        const initial = urls.length;

        let noNewCount = 0;
        let lastTotal = urls.length;
        let iterations = 0;

        while (noNewCount < 5 && iterations < 200) {
          iterations++;

          const beforeHeight = Math.max(
            document.body?.scrollHeight || 0,
            document.documentElement?.scrollHeight || 0
          );

          window.scrollTo({
            top: beforeHeight,
            behavior: 'instant'
          });

          document.documentElement.scrollTop = beforeHeight;

          if (document.body) {
            document.body.scrollTop = beforeHeight;
          }

          await sleep(1200);

          // Também percorre containers com scroll próprio.
          document.querySelectorAll('*').forEach(element => {
            if (
              element.scrollHeight > element.clientHeight + 100 &&
              element.clientHeight > 200
            ) {
              element.scrollTop = element.scrollHeight;
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

          const currentHeight = Math.max(
            document.body?.scrollHeight || 0,
            document.documentElement?.scrollHeight || 0
          );

          if (currentHeight > beforeHeight) {
            noNewCount = 0;
          }
        }

        window.scrollTo({ top: 0, behavior: 'instant' });

        return {
          urls,
          initial,
          total: urls.length,
          iterations
        };
      }
    });

    const data = results?.[0]?.result;

    if (!data) {
      logMsg('❌ Não foi possível coletar as imagens.');
      return;
    }

    const { urls, initial, total, iterations } = data;

    if (!urls.length) {
      logMsg('❌ Nenhuma imagem encontrada.');
      return;
    }

    logMsg(
      `✅ Inicial: ${initial} | Final: ${total}\n` +
      `Rolagens: ${iterations}\n\nBaixando...`
    );

    // Não filtramos por "logo", "icon", "avatar" etc.
    // O objetivo desta ação é baixar todas as imagens encontradas.
    const { started, failed } = await downloadUrls(urls);

    logMsg(
      `✅ ${started} downloads iniciados.\n` +
      (failed ? `⚠️ ${failed} downloads falharam.` : 'Todos os downloads foram enviados ao Chrome.')
    );
  } catch (error) {
    console.error('[WM] Erro:', error);
    logMsg(`❌ Erro: ${error?.message || error}`);
  }
});

/* ============================================================
   Extrair só o visível
   ============================================================ */
document.getElementById('extractImages').addEventListener('click', async () => {
  console.log('[WM] botão extractImages clicado');
  logMsg('Buscando imagens visíveis...');

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });

    if (!tab?.id) {
      logMsg('❌ Não foi possível identificar a aba ativa.');
      return;
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const seen = new Set();
        const urls = [];

        function addUrl(value) {
          if (!value || value.startsWith('data:') || value.startsWith('blob:')) {
            return;
          }

          try {
            const url = new URL(value, location.href).href;
            if (!/^https?:$/i.test(new URL(url).protocol)) return;
            if (!seen.has(url)) {
              seen.add(url);
              urls.push(url);
            }
          } catch {}
        }

        function collectSrcset(value) {
          if (!value) return;

          value.split(',').forEach(part => {
            addUrl(part.trim().split(/\s+/)[0]);
          });
        }

        document.querySelectorAll('img, source').forEach(element => {
          [
            'src',
            'data-src',
            'data-original',
            'data-lazy-src',
            'data-lazy',
            'data-original-src',
            'data-image',
            'data-image-src'
          ].forEach(attr => addUrl(element.getAttribute(attr)));

          collectSrcset(element.getAttribute('srcset'));
          collectSrcset(element.getAttribute('data-srcset'));
        });

        return urls;
      }
    });

    const urls = results?.[0]?.result || [];

    if (!urls.length) {
      logMsg('❌ Nenhuma imagem encontrada.');
      return;
    }

    logMsg(`✅ ${urls.length} imagens. Baixando...`);

    const { started, failed } = await downloadUrls(urls);

    logMsg(
      `✅ ${started} downloads iniciados.` +
      (failed ? ` ${failed} falharam.` : '')
    );
  } catch (error) {
    console.error('[WM] Erro:', error);
    logMsg(`❌ Erro: ${error?.message || error}`);
  }
});
