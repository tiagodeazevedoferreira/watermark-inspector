/* ============================================================
   Inpainting com detecção por cor consistente
   Otimizado para a marca d'água da FotoBase (azul escuro)
   ============================================================ */

// ⚠️ TROQUE PELO SEU USUÁRIO DO HUGGING FACE
const MODEL_URL = 'https://huggingface.co/tiagoaferreira/lama-onnx/blob/main/lama_fp16.onnx';

// Tamanho de entrada do LaMa (múltiplo de 32)
const INPUT_SIZE = 512;

// Faixa de cor da marca (azul escuro da FotoBase)
// Ajuste se necessário. Formato: [R_min, R_max, G_min, G_max, B_min, B_max]
const MARK_COLOR = {
  rMin: 20, rMax: 70,
  gMin: 40, gMax: 90,
  bMin: 80, bMax: 140,
};

let session = null;
let images = [];  // { url, canvas, maskCanvas, resultCanvas, status, error }

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

  // Lê URLs passadas pela extensão
  const data = await chrome.storage.local.get(['pendingUrls']);
  const urls = data.pendingUrls || [];

  if (urls.length === 0) {
    setStatus('⚠️ Nenhuma imagem recebida. Volte à extensão e clique em "Coletar tudo".', 'error');
    return;
  }

  setStatus(`Recebidas ${urls.length} imagens. Carregue o modelo para começar.`);

  // Cria os cards
  images = urls.map(url => ({
    url,
    canvas: null,
    maskCanvas: null,
    resultCanvas: null,
    status: 'pending',
  }));
  renderGrid();
});

/* ============================================================
   Carregar modelo
   ============================================================ */
async function loadModel() {
  const btn = document.getElementById('loadModelBtn');
  btn.disabled = true;

  try {
    setStatus('Baixando modelo do Hugging Face (~110 MB)... Aguarde.');

    session = await ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ['webgpu', 'wasm'],
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

      // 1. Baixar imagem
      setStatus(`[${i + 1}/${images.length}] Baixando imagem...`);
      item.canvas = await loadImageAsCanvas(item.url);

      // 2. Detectar marca por cor
      setStatus(`[${i + 1}/${images.length}] Detectando marca...`);
      item.maskCanvas = detectByColor(item.canvas);

      // 3. Rodar LaMa
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

    // Detecção: azul escuro característico
    const isBlue =
      r >= rMin && r <= rMax &&
      g >= gMin && g <= gMax &&
      b >= bMin && b <= bMax &&
      b > r + 20 &&      // azul maior que vermelho
      b > g + 10;        // azul maior que verde

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
  // 1. Redimensiona para INPUT_SIZE
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

  // 2. Monta tensor [1, 4, H, W]
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

  // 3. Roda
  const results = await session.run({ input: inputTensor });
  const outTensor = results[session.outputNames[0]];

  // 4. Converte tensor em canvas
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

  // 5. Volta ao tamanho original
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

    const badgeClass = item.status;
    const badgeText = {
      pending: '⏳',
      working: '🧠',
      done: '✅',
      error: '❌',
    }[item.status];

    let previewHTML = '';

    if (item.status === 'done' && item.resultCanvas) {
      const dataUrl = item.resultCanvas.toDataURL('image/jpeg', 0.7);
      previewHTML = `<img src="${dataUrl}" alt="">`;
    } else if (item.canvas) {
      const dataUrl = item.canvas.toDataURL('image/jpeg', 0.5);
      previewHTML = `<img src="${dataUrl}" alt="">`;
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
        <span class="badge ${badgeClass}">${badgeText}${item.error ? ' ' + item.error.slice(0, 30) : ''}</span>
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
function loadImageAsCanvas(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      c.getContext('2d').drawImage(img, 0, 0);
      resolve(c);
    };
    img.onerror = () => reject(new Error('Falha ao carregar imagem'));
    img.src = url;
  });
}
