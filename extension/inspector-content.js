(() => {
  const seen = new Set();
  const images = [];
  const candidates = new Map();
  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return null; } };
  const addCandidate = (url, source, confidence = 50) => {
    const u = abs(url);
    if (!u || u.startsWith('data:') || u.startsWith('blob:')) return;
    if (!candidates.has(u)) candidates.set(u, { url: u, sources: [], confidence });
    const c = candidates.get(u);
    if (!c.sources.includes(source)) c.sources.push(source);
    c.confidence = Math.max(c.confidence, confidence);
  };
  const attrNames = ['src','currentSrc','data-src','data-original','data-lazy-src','data-lazy','data-full','data-fullsize','data-original-src','data-image','data-image-url','data-large','data-zoom'];
  const isImageUrl = (u) => /\.(?:jpe?g|png|webp|gif|avif|bmp)(?:[?#]|$)/i.test(u) || /(?:image|photo|foto|media|asset|original|watermark|capas|fotos)/i.test(u);

  document.querySelectorAll('img').forEach((img, index) => {
    const record = { index, rect: (() => { const r=img.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })(), attrs: {}, urls: [] };
    attrNames.forEach(a => {
      const v = a === 'currentSrc' ? img.currentSrc : img.getAttribute(a);
      if (v) { record.attrs[a]=v; addCandidate(v, `img.${a}`, a==='src'||a==='currentSrc'?80:88); }
    });
    const srcset = img.getAttribute('srcset');
    if (srcset) {
      record.attrs.srcset=srcset;
      srcset.split(',').forEach(p=>{const u=p.trim().split(/\s+/)[0]; if(u){addCandidate(u,'img.srcset',84);}});
    }
    const parent = img.closest('picture');
    if (parent) parent.querySelectorAll('source[srcset]').forEach(s=>s.getAttribute('srcset').split(',').forEach(p=>{const u=p.trim().split(/\s+/)[0]; if(u)addCandidate(u,'picture.source',86);}));
    const style = getComputedStyle(img);
    if (style.backgroundImage && style.backgroundImage !== 'none') {
      const m=style.backgroundImage.match(/url\(["']?(.*?)["']?\)/); if(m) addCandidate(m[1],'img.background-image',70);
    }
    record.urls = [...new Set(Object.values(record.attrs).flatMap(v => typeof v === 'string' ? [v] : []))].filter(Boolean);
    images.push(record);
  });

  const inspectPseudo = (el, label) => {
    const s=getComputedStyle(el,label); const bg=s.backgroundImage;
    if(bg && bg!=='none'){const m=bg.match(/url\(["']?(.*?)["']?\)/); if(m)addCandidate(m[1],`${label}.background-image`,72);}
    if(s.content && s.content!=='none' && s.content!=='normal') addCandidate(s.content.replace(/^['"]|['"]$/g,''),`${label}.content`,55);
  };
  document.querySelectorAll('body *').forEach(el=>{ inspectPseudo(el,'::before'); inspectPseudo(el,'::after'); });
  document.querySelectorAll('svg image').forEach((el,i)=>{ const u=el.getAttribute('href')||el.getAttribute('xlink:href'); if(u)addCandidate(u,`svg.image[${i}]`,75); });

  const KEYWORDS=['watermark','marca','marca-dagua','marca_dagua','water-mark','overlay','protected','protection','logo-overlay','copyright','selo','stamp','brand'];
  const overlays=[];
  document.querySelectorAll('body *').forEach(el=>{
    const id=(el.id||'').toLowerCase();
    const cls=(typeof el.className==='string'?el.className:'').toLowerCase();
    const st=getComputedStyle(el);
    const text=(el.textContent||'').trim().slice(0,120).toLowerCase();
    let score=0;
    if(KEYWORDS.some(k=>id.includes(k)||cls.includes(k))) score+=4;
    if(KEYWORDS.some(k=>text.includes(k))) score+=2;
    if(st.position==='absolute'||st.position==='fixed') score+=1;
    if(parseInt(st.zIndex,10)>10) score+=1;
    if(st.pointerEvents==='none') score+=1;
    if(score>=3){ const r=el.getBoundingClientRect(); overlays.push({tag:el.tagName,id:el.id,className:typeof el.className==='string'?el.className:'',score,rect:{x:r.x,y:r.y,width:r.width,height:r.height}}); }
  });

  const resources = performance.getEntriesByType('resource').map(e=>e.name).filter(isImageUrl);
  resources.forEach(u=>addCandidate(u,'performance.resource',60));

  const variants = new Map();
  for (const c of candidates.values()) {
    const u=c.url;
    const add=(v,why,score)=>{ if(v && v!==u && /^https?:/i.test(v)) variants.set(v,{url:v,sources:[`derived:${why}`],confidence:score}); };
    add(u.replace(/fotos-watermarked/gi,'fotos-sem-marca'),'fotos-watermarked→fotos-sem-marca',97);
    add(u.replace(/\/fotos\//gi,'/fotos-sem-marca/'),'fotos→fotos-sem-marca',96);
    add(u.replace(/capas-watermarked/gi,'capas-sem-marca'),'capas-watermarked→capas-sem-marca',97);
    add(u.replace(/\/capas\//gi,'/capas-sem-marca/'),'capas→capas-sem-marca',96);
    add(u.replace(/\/watermarked\//gi,'/sem-marca/'),'watermarked→sem-marca',94);
    add(u.replace(/[-_]watermarked/gi,'-sem-marca'),'watermarked suffix→sem-marca',92);
    add(u.replace(/[-_]with[-_]watermark/gi,'-sem-marca'),'with-watermark→sem-marca',90);
    add(u.replace(/[-_]watermark(ed)?/gi,''),'watermark suffix removal',88);
    add(u.replace(/\/(?:thumb|thumbnail|preview|small|medium)\//gi,'/original/'),'size path→original',82);
    add(u.replace(/[-_](?:thumb|thumbnail|preview|small|medium|800|1024|1280)(?=\.[a-z0-9]+(?:[?#]|$))/i,''),'size suffix removal',78);
    add(u.replace(/([?&])(?:w|width|size)=\d+/i,'$1'),'remove width parameter',70);
  }

  return {
    capturedAt: new Date().toISOString(),
    page: { title: document.title, url: location.href },
    counts: { domImages: images.length, uniqueCandidates: candidates.size, resources: resources.length, possibleOverlays: overlays.length },
    images: images.slice(0, 500),
    overlays: overlays.sort((a,b)=>b.score-a.score).slice(0, 100),
    candidates: [...candidates.values()].sort((a,b)=>b.confidence-a.confidence).slice(0, 500),
    derivedCandidates: [...variants.values()].sort((a,b)=>b.confidence-a.confidence).slice(0, 500)
  };
})()