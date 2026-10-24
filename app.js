'use strict';

const { colors: WCOLORS, combos: WCOMBOS } = window.WADA;
const NC = WCOLORS.length;
const ANALYSIS_MAX = 240;   // long side of the downsampled image used for matching
const DISPLAY_MAX = 1200;
const KL = 2;               // CIEDE2000 lightness weight; 2 is the textile convention, forgiving of folds and shadows
const MARGIN = 2.5;         // a pixel also counts for colors within this ΔE of its best match
const EDGE = 36;            // pixels differing from their 3×3 neighbourhood by more than this are scrap edges, not fabric

// ---------- color math ----------

function srgbToLab(r, g, b) {
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const y = (0.2126729 * R + 0.7151522 * G + 0.0721750 * B);
  const z = (0.0193339 * R + 0.1191920 * G + 0.9503041 * B) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

const TAU = 2 * Math.PI, DEG = Math.PI / 180, POW25_7 = 6103515625;

function deltaE2000(L1, a1, b1, L2, a2, b2) {
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cb7 = ((C1 + C2) / 2) ** 7;
  const G = 0.5 * (1 - Math.sqrt(Cb7 / (Cb7 + POW25_7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  let h1p = Math.atan2(b1, a1p); if (h1p < 0) h1p += TAU;
  let h2p = Math.atan2(b2, a2p); if (h2p < 0) h2p += TAU;
  const dLp = L2 - L1, dCp = C2p - C1p;
  const CC = C1p * C2p;
  let dhp = 0;
  if (CC !== 0) { dhp = h2p - h1p; if (dhp > Math.PI) dhp -= TAU; else if (dhp < -Math.PI) dhp += TAU; }
  const dHp = 2 * Math.sqrt(CC) * Math.sin(dhp / 2);
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (CC !== 0) {
    if (Math.abs(h1p - h2p) <= Math.PI) hbp /= 2;
    else hbp = hbp < TAU ? (hbp + TAU) / 2 : (hbp - TAU) / 2;
  }
  const T = 1 - 0.17 * Math.cos(hbp - 30 * DEG) + 0.24 * Math.cos(2 * hbp)
    + 0.32 * Math.cos(3 * hbp + 6 * DEG) - 0.20 * Math.cos(4 * hbp - 63 * DEG);
  const dTheta = 30 * DEG * Math.exp(-((((hbp / DEG) - 275) / 25) ** 2));
  const Cbp7 = Cbp ** 7;
  const RC = 2 * Math.sqrt(Cbp7 / (Cbp7 + POW25_7));
  const Lm = (Lbp - 50) ** 2;
  const SL = 1 + 0.015 * Lm / Math.sqrt(20 + Lm);
  const SC = 1 + 0.045 * Cbp, SH = 1 + 0.015 * Cbp * T;
  const RT = -Math.sin(2 * dTheta) * RC;
  const l = dLp / (KL * SL), c = dCp / SC, h = dHp / SH;
  return Math.sqrt(l * l + c * c + h * h + RT * c * h);
}

const wadaLab = WCOLORS.map((c) => srgbToLab(...hexToRgb(c.hex)));

function nearestWada(lab) {
  return wadaLab
    .map((w, j) => ({ j, d: deltaE2000(lab[0], lab[1], lab[2], w[0], w[1], w[2]) }))
    .sort((p, q) => p.d - q.d);
}

// ---------- state ----------

const S = {
  img: null,
  raw: null,          // ImageData at analysis size, uncorrected
  w: 0, h: 0,
  wb: [1, 1, 1],
  wbMode: false,
  pxU: null,          // analysis pixel -> unique color index, -1 for edge pixels
  U: 0,
  uCount: null,
  dist: null,         // dist[j * U + u] = ΔE between Wada color j and unique color u
  best: null,         // best[u] = smallest ΔE from u to any Wada color
  bestJ: null,        // bestJ[u] = that Wada color
  total: 0,
  coverage: new Float32Array(NC),
  ignored: new Set(),
  added: new Set(),
  sizes: new Set([2, 3, 4]),
  shopFilter: null,
  tol: 8,
  minCov: 0.004,
};

const $ = (id) => document.getElementById(id);
const photo = $('photo'), overlay = $('overlay'), pop = $('pop');

// ---------- loading & analysis ----------

function loadFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    S.img = img;
    S.wb = [1, 1, 1];
    S.ignored.clear();
    S.added.clear();
    S.shopFilter = null;
    $('drop').hidden = true;
    $('stage').hidden = false;
    $('controls').hidden = false;
    $('hint').hidden = false;
    $('paletteBox').hidden = false;
    $('empty').hidden = true;
    $('results').hidden = false;
    $('wbReset').hidden = true;

    const s = Math.min(1, ANALYSIS_MAX / Math.max(img.naturalWidth, img.naturalHeight));
    S.w = Math.max(1, Math.round(img.naturalWidth * s));
    S.h = Math.max(1, Math.round(img.naturalHeight * s));
    const c = document.createElement('canvas');
    c.width = S.w; c.height = S.h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, S.w, S.h);
    S.raw = ctx.getImageData(0, 0, S.w, S.h);
    analyze();
  };
  img.onerror = () => alert('Could not read that image. If it is HEIC, try exporting it as JPEG.');
  img.src = url;
}

function corrected(v, k) { return Math.min(255, Math.round(v * k)); }

function drawPhoto() {
  const img = S.img;
  const s = Math.min(1, DISPLAY_MAX / Math.max(img.naturalWidth, img.naturalHeight));
  photo.width = overlay.width = Math.round(img.naturalWidth * s);
  photo.height = overlay.height = Math.round(img.naturalHeight * s);
  const ctx = photo.getContext('2d');
  ctx.drawImage(img, 0, 0, photo.width, photo.height);
  if (S.wb.some((k) => k !== 1)) {
    const d = ctx.getImageData(0, 0, photo.width, photo.height);
    const p = d.data;
    for (let i = 0; i < p.length; i += 4) {
      p[i] = corrected(p[i], S.wb[0]);
      p[i + 1] = corrected(p[i + 1], S.wb[1]);
      p[i + 2] = corrected(p[i + 2], S.wb[2]);
    }
    ctx.putImageData(d, 0, 0);
  }
  clearMask();
}

function analyze() {
  drawPhoto();
  const { w, h } = S, p = S.raw.data, n = w * h;
  const c = new Uint8ClampedArray(n * 3);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) c[i * 3 + k] = corrected(p[i * 4 + k], S.wb[k]);
  }
  // Quantize to 6 bits per channel so identical-looking pixels share one ΔE computation.
  const keyToU = new Int32Array(1 << 18).fill(-1);
  const pxU = new Int32Array(n).fill(-1);
  const rgb = [];
  const counts = [];
  for (let i = 0; i < n; i++) {
    const x = i % w, y = (i - x) / w;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) continue;
    let diff = 0;
    for (let k = 0; k < 3; k++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += c[(i + dy * w + dx) * 3 + k];
      diff += Math.abs(c[i * 3 + k] - sum / 9);
    }
    if (diff > EDGE) continue;
    const r = c[i * 3] >> 2, g = c[i * 3 + 1] >> 2, b = c[i * 3 + 2] >> 2;
    const key = (r << 12) | (g << 6) | b;
    let u = keyToU[key];
    if (u < 0) { u = keyToU[key] = counts.length; counts.push(0); rgb.push(r * 4 + 2, g * 4 + 2, b * 4 + 2); }
    counts[u]++;
    pxU[i] = u;
  }
  const U = counts.length;
  const dist = new Float32Array(NC * U);
  const best = new Float32Array(U).fill(Infinity);
  const bestJ = new Int32Array(U);
  for (let u = 0; u < U; u++) {
    const [L, a, b] = srgbToLab(rgb[u * 3], rgb[u * 3 + 1], rgb[u * 3 + 2]);
    for (let j = 0; j < NC; j++) {
      const wl = wadaLab[j];
      const d = dist[j * U + u] = deltaE2000(L, a, b, wl[0], wl[1], wl[2]);
      if (d < best[u]) { best[u] = d; bestJ[u] = j; }
    }
  }
  Object.assign(S, { pxU, U, uCount: Uint32Array.from(counts), dist, best, bestJ, total: n });
  update();
}

// Does unique color u count toward Wada color j? Pixels whose best match was
// ignored (e.g. the tabletop) are dropped entirely.
function matches(u, j) {
  const d = S.dist[j * S.U + u];
  return d < S.tol && d <= S.best[u] + MARGIN && !S.ignored.has(S.bestJ[u]);
}

// ---------- matching ----------

function computeCoverage() {
  const { U, uCount, total } = S;
  for (let j = 0; j < NC; j++) {
    let sum = 0;
    for (let u = 0; u < U; u++) if (matches(u, j)) sum += uCount[u];
    S.coverage[j] = sum / total;
  }
}

// For one combo, give each pixel to the closest of the combo's colors, so a
// single red scrap can't count as both "Carmine" and "Spectrum Red".
function evalCombo(combo) {
  const { U, dist, uCount, total, minCov } = S;
  const cs = combo.colors;
  const usable = cs.filter((j) => !S.ignored.has(j));
  const amount = new Map(cs.map((j) => [j, 0]));
  if (usable.length) {
    for (let u = 0; u < U; u++) {
      let best = -1, bd = Infinity;
      for (const j of usable) {
        const d = dist[j * U + u];
        if (d < bd && matches(u, j)) { bd = d; best = j; }
      }
      if (best >= 0) amount.set(best, amount.get(best) + uCount[u]);
    }
  }
  const missing = [];
  let score = Infinity;
  for (const j of cs) {
    const frac = amount.get(j) / total;
    const have = !S.ignored.has(j) && (S.added.has(j) || frac >= minCov);
    if (have) score = Math.min(score, S.added.has(j) ? Math.max(frac, minCov) : frac);
    else missing.push(j);
  }
  return { combo, missing, score };
}

function update() {
  if (!S.dist) return;
  computeCoverage();
  const results = WCOMBOS.filter((c) => S.sizes.has(c.colors.length)).map(evalCombo);
  const bySizeThenScore = (p, q) => q.combo.colors.length - p.combo.colors.length || q.score - p.score;
  const have = results.filter((r) => r.missing.length === 0).sort(bySizeThenScore);
  const near = results.filter((r) => r.missing.length === 1).sort(bySizeThenScore);

  renderPalette();
  renderShop(near);
  if (S.shopFilter !== null && !near.some((r) => r.missing[0] === S.shopFilter)) S.shopFilter = null;
  const nearShown = S.shopFilter === null ? near : near.filter((r) => r.missing[0] === S.shopFilter);
  renderGrid($('have'), have, 'None yet. Try raising the tolerance or lowering the minimum amount.');
  renderGrid($('near'), nearShown, 'Nothing here with the current settings.');
  $('haveCount').textContent = have.length;
  $('nearCount').textContent = near.length;
}

// ---------- rendering ----------

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function pct(f) { return f >= 0.1 ? Math.round(f * 100) + '%' : (f * 100).toFixed(1) + '%'; }

function renderPalette() {
  const box = $('palette');
  box.replaceChildren();
  const list = [];
  for (let j = 0; j < NC; j++) {
    if (S.coverage[j] >= S.minCov || S.added.has(j) || S.ignored.has(j)) list.push(j);
  }
  list.sort((p, q) => S.coverage[q] - S.coverage[p]);
  $('palCount').textContent = list.filter((j) => !S.ignored.has(j)).length;
  for (const j of list) {
    const chip = el('button', 'chip');
    chip.type = 'button';
    if (S.ignored.has(j)) chip.classList.add('ignored');
    const sw = el('i', 'sw');
    sw.style.background = WCOLORS[j].hex;
    chip.append(sw, el('span', 'nm', WCOLORS[j].name),
      el('span', 'pc', S.added.has(j) && S.coverage[j] < S.minCov ? 'added' : pct(S.coverage[j])));
    chip.title = S.ignored.has(j) ? 'Ignored. Click to use it again.'
      : S.added.has(j) ? 'Added by you. Click to remove.' : 'Click to ignore this color';
    chip.onclick = () => {
      if (S.ignored.has(j)) S.ignored.delete(j);
      else if (S.added.has(j)) S.added.delete(j);
      else S.ignored.add(j);
      update();
    };
    chip.onmouseenter = () => showMask([j]);
    chip.onmouseleave = clearMask;
    box.append(chip);
  }
  if (!list.length) box.append(el('p', 'hint', 'No book colors matched. Try raising the tolerance.'));
}

function renderShop(near) {
  const box = $('shop');
  box.replaceChildren();
  const tally = new Map();
  for (const r of near) tally.set(r.missing[0], (tally.get(r.missing[0]) || 0) + 1);
  const top = [...tally].sort((p, q) => q[1] - p[1]).slice(0, 10);
  if (!top.length) return;
  box.append(el('p', 'shop-title', 'Colors that would unlock the most combos (click one to filter):'));
  const row = el('div', 'chips');
  for (const [j, n] of top) {
    const chip = el('button', 'chip' + (S.shopFilter === j ? ' active' : ''));
    chip.type = 'button';
    const sw = el('i', 'sw');
    sw.style.background = WCOLORS[j].hex;
    chip.append(sw, el('span', 'nm', WCOLORS[j].name), el('span', 'pc', '+' + n));
    chip.onclick = () => { S.shopFilter = S.shopFilter === j ? null : j; update(); };
    row.append(chip);
  }
  box.append(row);
}

function renderGrid(box, results, emptyMsg) {
  box.replaceChildren();
  if (!results.length) { box.append(el('p', 'hint', emptyMsg)); return; }
  const frag = document.createDocumentFragment();
  for (const { combo, missing } of results) {
    const card = el('article', 'card');
    card.append(el('div', 'num', 'No. ' + String(combo.id).padStart(3, '0')));
    const bands = el('div', 'bands');
    const names = el('ul', 'names');
    for (const j of combo.colors) {
      const isMissing = missing.includes(j);
      const band = el('div', 'band' + (isMissing ? ' missing' : ''));
      band.style.background = WCOLORS[j].hex;
      if (isMissing) band.append(el('span', '', 'need'));
      bands.append(band);
      const li = el('li', isMissing ? 'missing' : '');
      const sw = el('i', 'sw');
      sw.style.background = WCOLORS[j].hex;
      li.append(sw, document.createTextNode(WCOLORS[j].name));
      names.append(li);
    }
    card.append(bands, names);
    const present = combo.colors.filter((j) => !missing.includes(j));
    card.onmouseenter = () => showMask(present);
    card.onmouseleave = clearMask;
    frag.append(card);
  }
  box.append(frag);
}

// ---------- photo overlay ----------

const maskCanvas = document.createElement('canvas');

function showMask(js) {
  if (!S.dist || !js.length) return;
  const { w, h, U, pxU } = S;
  maskCanvas.width = w; maskCanvas.height = h;
  const mctx = maskCanvas.getContext('2d');
  const d = mctx.createImageData(w, h);
  const hit = new Uint8Array(U);
  for (let u = 0; u < U; u++) for (const j of js) if (matches(u, j)) { hit[u] = 1; break; }
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    d.data[o] = d.data[o + 1] = d.data[o + 2] = 20;
    d.data[o + 3] = pxU[i] >= 0 && hit[pxU[i]] ? 0 : 200;
  }
  mctx.putImageData(d, 0, 0);
  const octx = overlay.getContext('2d');
  octx.clearRect(0, 0, overlay.width, overlay.height);
  octx.imageSmoothingEnabled = false;
  octx.drawImage(maskCanvas, 0, 0, overlay.width, overlay.height);
}

function clearMask() {
  overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
}

// Average a small neighbourhood of the analysis image around a click.
function sampleAt(evt, applyWb) {
  const rect = overlay.getBoundingClientRect();
  const cx = Math.floor(((evt.clientX - rect.left) / rect.width) * S.w);
  const cy = Math.floor(((evt.clientY - rect.top) / rect.height) * S.h);
  const p = S.raw.data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = Math.max(0, cy - 1); y <= Math.min(S.h - 1, cy + 1); y++) {
    for (let x = Math.max(0, cx - 1); x <= Math.min(S.w - 1, cx + 1); x++) {
      const o = (y * S.w + x) * 4;
      r += p[o]; g += p[o + 1]; b += p[o + 2]; n++;
    }
  }
  r /= n; g /= n; b /= n;
  if (applyWb) { r = corrected(r, S.wb[0]); g = corrected(g, S.wb[1]); b = corrected(b, S.wb[2]); }
  return [r, g, b];
}

overlay.addEventListener('click', (evt) => {
  if (!S.raw) return;
  if (S.wbMode) {
    const [r, g, b] = sampleAt(evt, false);
    const clamp = (k) => Math.min(4, Math.max(0.5, k));
    S.wb = [clamp(240 / Math.max(r, 1)), clamp(240 / Math.max(g, 1)), clamp(240 / Math.max(b, 1))];
    setWbMode(false);
    $('wbReset').hidden = false;
    analyze();
    return;
  }
  const rgb = sampleAt(evt, true);
  const top = nearestWada(srgbToLab(...rgb)).slice(0, 4);
  pop.replaceChildren();
  const head = el('div', 'pop-head');
  const sw = el('i', 'sw');
  sw.style.background = `rgb(${rgb.map(Math.round).join(',')})`;
  head.append(sw, el('span', '', 'Closest book colors'));
  const close = el('button', 'x', '×');
  close.type = 'button';
  close.onclick = () => { pop.hidden = true; };
  head.append(close);
  pop.append(head);
  for (const { j, d } of top) {
    const row = el('div', 'pop-row');
    const s = el('i', 'sw');
    s.style.background = WCOLORS[j].hex;
    row.append(s, el('span', 'nm', WCOLORS[j].name), el('span', 'pc', 'ΔE ' + d.toFixed(1)));
    const btn = el('button', 'add');
    btn.type = 'button';
    const found = S.coverage[j] >= S.minCov && !S.ignored.has(j);
    if (S.added.has(j) || found) { btn.textContent = found ? 'found' : 'added'; btn.disabled = true; }
    else {
      btn.textContent = 'I have it';
      btn.onclick = () => { S.added.add(j); S.ignored.delete(j); pop.hidden = true; update(); };
    }
    row.append(btn);
    pop.append(row);
  }
  const stage = $('stage').getBoundingClientRect();
  pop.hidden = false;
  const x = Math.min(evt.clientX - stage.left + 12, stage.width - pop.offsetWidth - 4);
  const y = Math.min(evt.clientY - stage.top + 12, stage.height - pop.offsetHeight - 4);
  pop.style.left = Math.max(4, x) + 'px';
  pop.style.top = Math.max(4, y) + 'px';
});

function setWbMode(on) {
  S.wbMode = on;
  $('wbBtn').classList.toggle('active', on);
  $('wbBtn').textContent = on ? 'Click something white…' : 'Set white point';
  $('stage').classList.toggle('picking', on);
}

// ---------- controls ----------

function syncOutputs() {
  $('tolOut').textContent = 'ΔE ' + S.tol;
  $('covOut').textContent = (S.minCov * 100).toFixed(1) + '% of photo';
}

let pending = 0;
function scheduleUpdate() {
  cancelAnimationFrame(pending);
  pending = requestAnimationFrame(update);
}

$('tol').addEventListener('input', (e) => { S.tol = +e.target.value; syncOutputs(); scheduleUpdate(); });
$('cov').addEventListener('input', (e) => { S.minCov = e.target.value / 100; syncOutputs(); scheduleUpdate(); });
$('wbBtn').addEventListener('click', () => setWbMode(!S.wbMode));
$('wbReset').addEventListener('click', () => { S.wb = [1, 1, 1]; $('wbReset').hidden = true; analyze(); });
$('newPhoto').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });
document.querySelectorAll('input[name=size]').forEach((cb) => cb.addEventListener('change', () => {
  if (cb.checked) S.sizes.add(+cb.value); else S.sizes.delete(+cb.value);
  update();
}));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { pop.hidden = true; setWbMode(false); }
});

const left = document.querySelector('.left');
left.addEventListener('dragover', (e) => { e.preventDefault(); left.classList.add('dragging'); });
left.addEventListener('dragleave', () => left.classList.remove('dragging'));
left.addEventListener('drop', (e) => {
  e.preventDefault();
  left.classList.remove('dragging');
  loadFile(e.dataTransfer.files[0]);
});

S.tol = +$('tol').value;
S.minCov = $('cov').value / 100;
syncOutputs();
