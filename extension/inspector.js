(async () => {
const data = await chrome.storage.local.get(['inspection']);
const report = data.inspection;
const status = document.getElementById('status');
const summary = document.getElementById('summary');
const resultsEl = document.getElementById('results');
const overlayEl = document.getElementById('overlays');
const networkEl = document.getElementById('network');
const continueBtn = document.getElementById('continueBtn');

if (!report) {
  status.textContent = 'Nenhum diagnóstico disponível.';
  continueBtn.disabled = true;
} else {
  summary.innerHTML = `
    <div class="stat"><b>Página</b><br>${escapeHtml(report.page.title || '(sem título)')}</div>
    <div class="stat"><b>Imagens DOM</b><br>${report.counts.domImages}</div>
    <div class="stat"><b>Candidatos</b><br>${report.counts.uniqueCandidates}</div>
    <div class="stat"><b>Recursos de imagem</b><br>${report.counts.resources}</div>
    <div class="stat"><b>Rede capturada</b><br>${report.networkSummary?.total || 0}</div>
    <div class="stat"><b>Imagens na rede</b><br>${report.networkSummary?.imageRequests || 0}</div>
    <div class="stat"><b>APIs/XHR</b><br>${report.networkSummary?.apiLikeRequests || 0}</div>
    <div class="stat"><b>Possíveis overlays</b><br>${report.counts.possibleOverlays}</div>
  `;
  renderOverlays(report.overlays || []);
  renderNetwork(report);
  runDiagnosis(report).catch(err => {
    console.error(err);
    status.textContent = '❌ Falha no diagnóstico: ' + err.message;
  });
}

document.getElementById('backBtn').addEventListener('click', () => window.close());

continueBtn.addEventListener('click', async () => {
  const optimized = report.optimizedUrls || [];
  await chrome.storage.local.set({ pendingUrls: optimized });
  await chrome.tabs.create({ url: chrome.runtime.getURL('inpaint.html') });
});

document.getElementById('downloadReportBtn').addEventListener('click', async () => {
  const blob = new Blob([JSON.stringify(report, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({url, filename:'watermark-inspector-diagnostico.json', saveAs:true});
  setTimeout(()=>URL.revokeObjectURL(url), 10000);
});

async function runDiagnosis(r) {
  status.textContent = 'Investigando candidatos, rede e versões alternativas...';
  const optimized = [];
  const rows = [];
  const networkImages = (r.networkImages || []).map(x => x.url).filter(Boolean);
  const discovered = [...new Set([...(r.networkUrlIndex || []), ...networkImages])];

  for (let i=0; i<r.images.length; i++) {
    const image = r.images[i];
    const originals = unique([
      image.attrs?.currentSrc, image.attrs?.src, image.attrs?.['data-original'],
      image.attrs?.['data-full'], image.attrs?.['data-fullsize'], image.attrs?.['data-image'],
      ...(image.urls||[])
    ]);
    const candidates = [];
    for (const u of originals.slice(0, 8)) {
      candidates.push({url:u, score:80, reason:'origem observada'});
      for (const v of deriveVariants(u)) candidates.push(v);
    }

    const signature = imageSignature(originals[0] || '');
    for (const u of discovered) {
      if (looksRelated(u, signature)) {
        candidates.push({url:u, score:93, reason:'recurso relacionado capturado na rede'});
        for (const v of deriveVariants(u)) candidates.push(v);
      }
    }

    const ranked = uniqueObjects(candidates).sort((a,b)=>b.score-a.score).slice(0, 24);
    const probes = [];
    for (const c of ranked) {
      const p = await probe(c.url);
      probes.push({...c, ...p});
      if (p.ok && isStrongAlternative(c.url, originals[0])) {
        c.score = Math.max(c.score, 115);
        break;
      }
    }

    const available = probes.filter(p=>p.ok);
    const strong = available.filter(p => isStrongAlternative(p.url, originals[0]));
    const best = [...strong, ...available].sort((a,b)=>b.score-a.score)[0] || ranked[0];
    const original = originals[0] || '';
    optimized.push(best?.url || original);
    rows.push({
      index:i+1,
      original,
      best:best?.url||'',
      bestReason:best?.reason||'',
      bestProbe:best || null,
      candidates:probes
    });
    status.textContent = `Investigando ${i+1}/${r.images.length}...`;
  }

  r.optimizedUrls = optimized.filter(Boolean);
  r.results = rows;
  r.cleanUrls = rows.filter(x => x.best && x.best !== x.original && /sem[-_ ]?marca|sem[-_ ]?watermark|original|full|download|highres/i.test(x.best)).map(x=>x.best);
  await chrome.storage.local.set({inspection:r, pendingUrls:r.optimizedUrls});
  renderResults(rows);
  continueBtn.disabled = r.optimizedUrls.length===0;
  const changed = rows.filter(x=>x.best && x.original && x.best!==x.original).length;
  status.textContent = `✅ Diagnóstico concluído. ${changed} imagem(ns) possuem candidato alternativo utilizável.`;
}

async function probe(url) {
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), 7000);
  try {
    const response = await fetch(url, {method:'GET', credentials:'include', cache:'no-store', signal:controller.signal});
    const type = response.headers.get('content-type') || '';
    const declaredLength = response.headers.get('content-length') || '';
    const ok = response.ok && type.toLowerCase().startsWith('image/');
    let width = 0, height = 0, bytes = 0;
    if (ok) {
      const blob = await response.blob();
      bytes = blob.size;
      try {
        const bmp = await createImageBitmap(blob);
        width = bmp.width; height = bmp.height; bmp.close();
      } catch {}
    }
    return {ok, status:response.status, type, length:declaredLength, bytes, width, height};
  } catch (e) {
    return {ok:false, error:e.name==='AbortError'?'timeout/aborted':e.message};
  } finally { clearTimeout(timer); }
}

function isStrongAlternative(url, original) {
  if (!url || url === original) return false;
  return /sem[-_ ]?marca|sem[-_ ]?watermark|original|full|download|highres|fotos-sem-marca|capas-sem-marca/i.test(url);
}

function imageSignature(url) {
  if (!url) return {hash:'', event:''};
  const clean = url.split('?')[0];
  const parts = clean.split('/').filter(Boolean);
  return {hash:parts[parts.length-1] || '', event:parts.find(x=>/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(x)) || ''};
}

function looksRelated(url, sig) {
  if (!url) return false;
  if (sig.hash && url.includes(sig.hash)) return true;
  if (sig.event && url.includes(sig.event)) return true;
  return false;
}

function deriveVariants(u) {
  const out=[];
  const add=(v,reason,score)=>{ if(v && v!==u && /^https?:/i.test(v)) out.push({url:v,score,reason}); };
  add(u.replace(/fotos-watermarked/gi,'fotos-sem-marca'),'fotos-watermarked → fotos-sem-marca',100);
  add(u.replace(/\/fotos\//gi,'/fotos-sem-marca/'),'fotos → fotos-sem-marca',99);
  add(u.replace(/capas-watermarked/gi,'capas-sem-marca'),'capas-watermarked → capas-sem-marca',99);
  add(u.replace(/\/capas\//gi,'/capas-sem-marca/'),'capas → capas-sem-marca',98);
  add(u.replace(/\/watermarked\//gi,'/sem-marca/'),'watermarked → sem-marca',98);
  add(u.replace(/watermark(ed)?/gi,'sem-marca'),'watermark → sem-marca',96);
  add(u.replace(/with[-_]?watermark/gi,'sem-marca'),'with-watermark → sem-marca',95);
  add(u.replace(/[-_](?:thumb|thumbnail|preview|small|medium)(?=[._/-])/gi,''),'tamanho reduzido → original',85);
  add(u.replace(/[-_](?:800|1024|1280|1600|1920)(?=\.[a-z0-9]+(?:[?#]|$))/i,''),'sufixo de resolução → original',82);
  add(u.replace(/\/(?:thumb|thumbnail|preview|small|medium)\//gi,'/original/'),'pasta reduzida → original',84);
  return uniqueObjects(out);
}

function unique(a){ return [...new Set(a.filter(Boolean))]; }
function uniqueObjects(a){ const m=new Map(); for(const x of a){if(!m.has(x.url)||m.get(x.url).score<x.score)m.set(x.url,x);} return [...m.values()]; }

function renderResults(rows){
  resultsEl.innerHTML = rows.map(r=>`<div class="row"><div><b>#${r.index}</b> ${escapeHtml(r.original)}</div><div class="best">${r.best && r.best!==r.original ? '🟢 '+escapeHtml(r.best) : '⚪ '+escapeHtml(r.best||'nenhum')}</div><div class="reason">${escapeHtml(r.bestReason||'')}${r.bestProbe?.ok ? ` · HTTP ${r.bestProbe.status} · ${r.bestProbe.width||'?'}×${r.bestProbe.height||'?'} · ${r.bestProbe.bytes||0} bytes` : ''}</div></div>`).join('');
}

function renderOverlays(items){
  overlayEl.innerHTML=items.length?items.map(x=>`<div class="row"><b>${escapeHtml(x.tag)}</b> score ${x.score} — #${escapeHtml(x.id||'')} ${escapeHtml(x.className||'')}</div>`).join(''):'<div>Nenhum overlay evidente por heurística.</div>';
}

function renderNetwork(r){
  const apis = r.networkApis || [];
  const imgs = r.networkImages || [];
  networkEl.innerHTML =
    `<div class="row"><b>${imgs.length}</b> imagens observadas na rede · <b>${apis.length}</b> requisições API/XHR relacionadas.</div>` +
    apis.slice(0,80).map(x=>`<div class="row"><b>${escapeHtml(x.type||'')}</b> HTTP ${x.statusCode||'?'} · ${escapeHtml(x.contentType||'')}<br>${escapeHtml(x.url||'')}</div>`).join('');
}

function escapeHtml(v){return String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}
})();