const PROXIES = [
  { name: 'AllOrigins', build: u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
  { name: 'corsproxy.io', build: u => `https://corsproxy.io/?url=${encodeURIComponent(u)}` },
  { name: 'CodeTabs', build: u => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}` },
];

document.getElementById('analyzeBtn').addEventListener('click', analyze);

async function analyze() {
  const url = document.getElementById('urlInput').value.trim();
  const status = document.getElementById('status');
  const results = document.getElementById('results');
  const grid = document.getElementById('grid');
  const count = document.getElementById('count');

  if (!url) return status.textContent = 'Cole uma URL primeiro.';

  status.textContent = 'Buscando HTML via proxy...';
  results.style.display = 'none';

  let html = null;
  let usedProxy = '';

  for (const proxy of PROXIES) {
    try {
      status.textContent = `Tentando ${proxy.name}...`;
      const res = await fetch(proxy.build(url));
      if (res.ok) {
        html = await res.text();
        usedProxy = proxy.name;
        break;
      }
    } catch (e) {
      console.warn(proxy.name, 'falhou:', e.message);
    }
  }

  if (!html) {
    status.textContent = '❌ Todos os proxies falharam. Tente outra URL.';
    return;
  }

  status.textContent = `✅ HTML obtido via ${usedProxy} (${html.length} bytes)`;

  const doc = new DOMParser().parseFromString(html, 'text/html');
  const base = new URL(url);
  const imgs = [...doc.querySelectorAll('img')];
  const seen = new Set();
  const urls = [];

  imgs.forEach(img => {
    ['src', 'data-src', 'data-original', 'data-lazy-src'].forEach(attr => {
      const v = img.getAttribute(attr);
      if (!v || v.startsWith('data:')) return;
      try {
        const u = new URL(v, base).href;
        if (!seen.has(u)) { seen.add(u); urls.push(u); }
      } catch {}
    });
  });

  count.textContent = urls.length;
  grid.innerHTML = '';

  // Detecta SPA (site dinâmico)
  if (urls.length < 3 && html.length < 10000) {
    grid.innerHTML = `
      <div style="grid-column: 1/-1; padding: 20px; background: #1e222b; border-radius: 10px; border: 1px solid #2a2f3a;">
        <h3 style="color: #f59e0b; margin-top: 0;">⚠️ Este site é dinâmico (SPA)</h3>
        <p>O HTML inicial não contém as imagens — elas são carregadas por JavaScript depois.</p>
        <p><strong>Solução:</strong> use a extensão do Chrome (veja o README).</p>
        <p>Ou teste com um site mais simples, como um blog ou galeria estática.</p>
      </div>
    `;
  } else if (urls.length === 0) {
    grid.innerHTML = '<p>Nenhuma imagem encontrada.</p>';
  } else {
    urls.forEach(u => {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
        <img src="${u}" loading="lazy" onerror="this.style.opacity=.2">
        <div class="actions">
          <a href="${u}" target="_blank">Abrir</a>
          <a href="${u}" download>Baixar</a>
        </div>
      `;
      grid.appendChild(card);
    });
  }

  results.style.display = 'block';
}
