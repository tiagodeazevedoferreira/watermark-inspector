/* ============================================================
   Inpainting com detecção por cor
   Backend WASM (compatível com Chrome Extension MV3)
   ============================================================ */

// ⚠️ URL correta do modelo (usa /resolve/, não /blob/)
const MODEL_URL = 'https://huggingface.co/tiagoaferreira/lama-onnx/resolve/main/lama_fp16.onnx';

// Configuração do ONNX Runtime — aponta para a pasta lib/ local
ort.env.wasm.wasmPaths = chrome.runtime.getURL('lib/');
ort.env.wasm.numThreads = 1;
ort.env.wasm.simd = true;

// Tamanho de entrada do LaMa (múltiplo de 32)
const INPUT_SIZE = 512;

// Faixa de cor da marca (azul escuro da FotoBase)
const MARK_COLOR = {
  rMin: 20, rMax: 70,
  gMin: 40, gMax: 90,
  bMin: 80, bMax: 140,
};

let session = null;
let images = [];

/* ============================================================
   Boot — lê URLs do storage
   ============================================================ */
document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('loadModelBtn').addEventListener('click', loadModel);
  document.getElementById('startBtn').addEventListener('click', processAll);
  document.getElementById('downloadAllBtn').addEventListener('click', downloadAll);
  document.getElementById('abortBtn').addEventListener('click', () => {
    window.__abort = true;
    setStatus('Abortando...', 'error');
  });

  const data = await chrome.storage.local.get(['pendingUrls']);
  const urls = data.pendingUrls || [];

  if (urls.length === 0) {
    setStatus('⚠️ Nenhuma imagem recebida. Volte à extensão e clique em "Coletar tudo".', 'error');
    return;
  }

  setStatus(`Recebidas ${urls.length} imagens. Carregue o modelo para começar.`);

  images = urls.map(url => ({
    url,
    canvas: null,
    maskCanvas: null,
    resultCanvas: null,
    status: 'pending',
    error: null,
  }));
  renderGrid();
});

/* ============================================================
   Carregar modelo (backend WASM)
   ============================================================ */
async function loadModel() {
  const btn = document.getElementById('loadModelBtn');
  btn.disabled = true;

  try {
    setStatus('Baixando modelo do Hugging Face (~110 MB)... Aguarde.');
    console.log('Model URL:', MODEL_URL);
    console.log('wasmPaths:', ort.env.wasm.wasmPaths);

    session = await ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });

    setStatus('✅ Modelo carregado! Clique em "Processar imagens".', 'ok');
    document.getElementById('startBtn').disabled = false;
    btn.textContent = '✅ Modelo pronto';
  } catch (err) {
    console.error(err);
    setStatus('❌ Erro ao carregar modelo: ' + err.message, 'error');
    btn.disabled = false;
  }
}

/* ============================================================
   Processar todas as imagens
   ============================================================ */
async function processAll() {
  if (!session) return;

  window.__abort = false;
  document.getElementById('startBtn').disabled = true;
  document.getElementById('abortBtn').disabled = false;

  for (let i = 0; i < images.length; i++) {
    if (window.__abort) break;

    const item = images[i];
    if (item.status === 'done') continue;

    try {
      updateProgress(i, images.length);
      item.status = 'working';
      renderGrid();

      setStatus(`[${i + 1}/${images.length}] Baixando imagem...`);
      item.canvas = await loadImageAsCanvas(item.url);

      setStatus(`[${i + 1}/${images.length}] Detectando marca...`);
      item.maskCanvas = detectByColor(item.canvas);

      setStatus(`[${i + 1}/${images.length}] Removendo marca com IA...`);
      item.resultCanvas = await runInpaint(item.canvas, item.maskCanvas);

      item.status = 'done';
    } catch (err) {
      console.error('Erro em', item.url, err);
      item.status = 'error';
      item.error = err.message;
    }
    renderGrid();
  }

  updateProgress(images.length, images.length);
  document.getElementById('startBtn').disabled = false;
  document.getElementById('abortBtn').disabled = true;

  const done = images.filter(i => i.status === 'done').length;
  setStatus(`✅ Concluído: ${done}/${images.length} imagens processadas.`, 'ok');
  document.getElementById('downloadAllBtn').disabled = false;
}

/* ============================================================
   Detecção por cor (azul escuro)
   ============================================================ */
function detectByColor(sourceCanvas) {
  const W = sourceCanvas.width;
  const H = sourceCanvas.height;
  const ctx = sourceCanvas.getContext('2d');
  const imgData = ctx.getImageData(0, 0, W, H);
  const data = imgData.data;

  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = W;
  maskCanvas.height = H;
  const mctx = maskCanvas.getContext('2d');
  const maskData = mctx.createImageData(W, H);

  const { rMin, rMax, gMin, gMax, bMin, bMax } = MARK_COLOR;
  let count = 0;

  for (let i = 0; i < W * H; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];

    const isBlue =
      r >= rMin && r <= rMax &&
      g >= gMin && g <= gMax &&
      b >= bMin && b <= bMax &&
      b > r + 20 &&
      b > g + 10;

    if (isBlue) {
      maskData.data[i * 4]     = 255;
      maskData.data[i * 4 + 1] = 0;
      maskData.data[i * 4 + 2] = 100;
      maskData.data[i * 4 + 3] = 230;
      count++;
    }
  }

  mctx.putImageData(maskData, 0, 0);
  console.log(`Detecção: ${count} pixels (${(count / (W * H) * 100).toFixed(1)}%)`);
  return maskCanvas;
}

/* ============================================================
   Inpainting com LaMa
   ============================================================ */
async function runInpaint(photoCanvas, maskCanvas) {
  const W = INPUT_SIZE;
  const H = INPUT_SIZE;

  const tmpPhoto = document.createElement('canvas');
  tmpPhoto.width = W;
  tmpPhoto.height = H;
  const pctx = tmpPhoto.getContext('2d');
  pctx.drawImage(photoCanvas, 0, 0, W, H);
  const photoData = pctx.getImageData(0, 0, W, H).data;

  const tmpMask = document.createElement('canvas');
  tmpMask.width = W;
  tmpMask.height = H;
  const mctx = tmpMask.getContext('2d');
  mctx.drawImage(maskCanvas, 0, 0, W, H);
  const maskData = mctx.getImageData(0, 0, W, H).data;

  const channel = H * W;
  const arr = new Float32Array(4 * channel);

  for (let i = 0; i < channel; i++) {
    const p = i * 4;
    const isMasked = maskData[p + 3] > 20 ? 1 : 0;

    arr[i]               = (photoData[p]     / 255) * (1 - isMasked);
    arr[channel + i]     = (photoData[p + 1] / 255) * (1 - isMasked);
    arr[channel * 2 + i] = (photoData[p + 2] / 255) * (1 - isMasked);
    arr[channel * 3 + i] = isMasked;
  }

  const inputTensor = new ort.Tensor('float32', arr, [1, 4, H, W]);

  const results = await session.run({ input: inputTensor });
  const outTensor = results[session.outputNames[0]];

  const [, , OH, OW] = outTensor.dims;
  const outData = outTensor.data;

  const tmpOut = document.createElement('canvas');
  tmpOut.width = OW;
  tmpOut.height = OH;
  const octx = tmpOut.getContext('2d');
  const imgOut = octx.createImageData(OW, OH);

  const oChannel = OH * OW;
  for (let i = 0; i < oChannel; i++) {
    imgOut.data[i * 4]     = Math.round(outData[i] * 255);
    imgOut.data[i * 4 + 1] = Math.round(outData[oChannel + i] * 255);
    imgOut.data[i * 4 + 2] = Math.round(outData[oChannel * 2 + i] * 255);
    imgOut.data[i * 4 + 3] = 255;
  }
  octx.putImageData(imgOut, 0, 0);

  const finalCanvas = document.createElement('canvas');
  finalCanvas.width = photoCanvas.width;
  finalCanvas.height = photoCanvas.height;
  finalCanvas.getContext('2d').drawImage(tmpOut, 0, 0, photoCanvas.width, photoCanvas.height);

  return finalCanvas;
}

/* ============================================================
   Download
   ============================================================ */
async function downloadAll() {
  const done = images.filter(i => i.status === 'done');
  if (done.length === 0) return;

  setStatus(`Baixando ${done.length} imagens...`);

  for (let i = 0; i < done.length; i++) {
    const item = done[i];
    const blob = await new Promise(r => item.resultCanvas.toBlob(r, 'image/jpeg', 0.92));

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `limpa-${String(i + 1).padStart(3, '0')}.jpg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);

    await new Promise(r => setTimeout(r, 300));
  }

  setStatus(`✅ ${done.length} imagens baixadas.`, 'ok');
}

/* ============================================================
   UI
   ============================================================ */
function renderGrid() {
  const grid = document.getElementById('grid');
  grid.innerHTML = '';

  images.forEach((item, i) => {
    const card = document.createElement('div');
    card.className = 'card';

    const badgeText = {
      pending: '⏳',
      working: '🧠',
      done: '✅',
      error: '❌',
    }[item.status];

    let previewHTML = '';

    if (item.status === 'done' && item.resultCanvas) {
      previewHTML = `<img src="${item.resultCanvas.toDataURL('image/jpeg', 0.7)}" alt="">`;
    } else if (item.canvas) {
      previewHTML = `<img src="${item.canvas.toDataURL('image/jpeg', 0.5)}" alt="">`;
    } else {
      previewHTML = `<img src="${item.url}" alt="" loading="lazy">`;
    }

    card.innerHTML = `
      <div class="preview">
        ${previewHTML}
        ${item.status === 'working' ? '<div class="loading-overlay"><div class="spinner"></div></div>' : ''}
      </div>
      <div class="label">
        <span>#${i + 1}</span>
        <span class="badge ${item.status}">${badgeText}${item.error ? ' ' + item.error.slice(0, 30) : ''}</span>
      </div>
    `;

    grid.appendChild(card);
  });
}

function setStatus(msg, kind) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

function updateProgress(done, total) {
  const pct = total ? (done / total) * 100 : 0;
  document.getElementById('progressFill').style.width = pct + '%';
}

/* ============================================================
   Utils
   ============================================================ */
async function loadImageAsCanvas(url) {
  let response;

  try {
    response = await fetch(url, {
      credentials: 'include',
    });
  } catch (err) {
    throw new Error(`Falha de rede ao carregar imagem: ${err.message}`);
  }

  if (!response.ok) {
    throw new Error(`Falha ao carregar imagem (HTTP ${response.status})`);
  }

  const blob = await response.blob();

  if (!blob.type.startsWith('image/')) {
    throw new Error(`URL não retornou uma imagem (${blob.type || 'tipo desconhecido'})`);
  }

  const objectUrl = URL.createObjectURL(blob);

  try {
    const img = await new Promise((resolve, reject) => {
      const image = new Image();

      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Falha ao decodificar imagem'));

      image.src = objectUrl;
    });

    const c = document.createElement('canvas');
    c.width = img.naturalWidth || img.width;
    c.height = img.naturalHeight || img.height;

    c.getContext('2d').drawImage(img, 0, 0);

    return c;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
