(async () => {
const data = await chrome.storage.local.get(['inspection']);
const report = data.inspection;
const status = document.getElementById('status');
const summary = document.getElementById('summary');
const resultsEl = document.getElementById('results');
const overlayEl = document.getElementById('overlays');
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
    <div class="stat"><b>Possíveis overlays</b><br>${report.counts.possibleOverlays}</div>
  `;
  renderOverlays(report.overlays || []);
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
  status.textContent = 'Investigando candidatos e versões alternativas...';
  const optimized = [];
  const rows = [];

  for (let i=0; i<r.images.length; i++) {
    const image = r.images[i];
    const originals = unique([
      image.attrs?.currentSrc, image.attrs?.src, image.attrs?.['data-original'],
      image.attrs?.['data-full'], image.attrs?.['data-fullsize'], image.attrs?.['data-image'],
      ...(image.urls||[])
    ]);
    const candidates = [];
    for (const u of originals.slice(0, 5)) {
      candidates.push({url:u, score:80, reason:'origem observada'});
      for (const v of deriveVariants(u)) candidates.push(v);
    }
    const ranked = uniqueObjects(candidates).sort((a,b)=>b.score-a.score).slice(0, 12);
    const probes = [];
    for (const c of ranked) {
      const p = await probe(c.url);
      probes.push({...c, ...p});
      if (p.ok && /sem[-_ ]?marca|sem[-_ ]?watermark|original|full|download|highres/i.test(c.url)) break;
    }
    const available = probes.filter(p=>p.ok);
    const best = available.sort((a,b)=>b.score-a.score)[0] || probes.find(p=>p.ok) || ranked[0];
    optimized.push(best?.url || originals[0] || '');
    rows.push({index:i+1, original:originals[0]||'', best:best?.url||'', bestReason:best?.reason||'', candidates:probes});
    status.textContent = `Investigando ${i+1}/${r.images.length}...`;
  }

  r.optimizedUrls = optimized.filter(Boolean);
  r.results = rows;
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
    const length = response.headers.get('content-length') || '';
    const ok = response.ok && type.toLowerCase().startsWith('image/');
    controller.abort();
    return {ok, status:response.status, type, length};
  } catch (e) {
    return {ok:false, error:e.name==='AbortError'?'timeout/aborted':e.message};
  } finally { clearTimeout(timer); }
}

function deriveVariants(u) {
  const out=[];
  const add=(v,reason,score)=>{ if(v && v!==u && /^https?:/i.test(v)) out.push({url:v,score,reason}); };
  add(u.replace(/fotos-watermarked/gi,'fotos-sem-marca'),'fotos-watermarked → fotos-sem-marca',100);
  add(u.replace(/\/fotos\//gi,'/fotos-sem-marca/'),'fotos → fotos-sem-marca',99);
  add(u.replace(/capas-watermarked/gi,'capas-sem-marca'),'capas-watermarked → capas-sem-marca',99);
  add(u.replace(/\/capas\//gi,'/capas-sem-marca/'),'capas → capas-sem-marca',98);
  add(u.replace(/watermarked/gi,'sem-marca'),'watermarked → sem-marca',98);
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
  resultsEl.innerHTML = rows.map(r=>`<div class="row"><div><b>#${r.index}</b> ${escapeHtml(r.original)}</div><div class="best">${r.best && r.best!==r.original ? '🟢 '+escapeHtml(r.best) : '⚪ '+escapeHtml(r.best||'nenhum')}</div><div class="reason">${escapeHtml(r.bestReason||'')}</div></div>`).join('');
}
function renderOverlays(items){
  overlayEl.innerHTML=items.length?items.map(x=>`<div class="row"><b>${escapeHtml(x.tag)}</b> score ${x.score} — #${escapeHtml(x.id||'')} ${escapeHtml(x.className||'')}</div>`).join(''):'<div>Nenhum overlay evidente por heurística.</div>';
}
function escapeHtml(v){return String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}

})();