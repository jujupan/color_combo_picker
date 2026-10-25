'use strict';

const { colors: WCOLORS, combos: WCOMBOS } = window.WADA;
const NC = WCOLORS.length;
const ANALYSIS_MAX = 240;   // long side of the downsampled image used for matching
const DISPLAY_MAX = 1200;
const FABRIC_MAX = 160;     // long side of a stored fabric swatch
const KL = 2;               // CIEDE2000 lightness weight; 2 is the textile convention, forgiving of folds and shadows
const MARGIN = 2.5;         // a pixel also counts for colors within this ΔE of its best match
const EDGE = 36;            // pixels differing from their 3×3 neighbourhood by more than this are scrap edges, not fabric
const LEAD = 0.15;          // a fabric provides a color when that color is at least this share of the fabric
const MIN_MATCHED = 0.25;   // fabrics with less than this share near any book color are left out
const STORE_KEY = 'scrapcombo.fabrics.v1';

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
  raw: null,          // ImageData of the pile photo at analysis size, uncorrected
  w: 0, h: 0,
  wb: [1, 1, 1],
  wbMode: false,
  A: null,            // analysis of the pile photo (see analyzePixels)
  coverage: new Float32Array(NC),
  ignored: new Set(),
  added: new Set(),
  fabrics: [],        // { id, name, thumb, on, A, groups, share, matched }
  fabTol: null,       // tolerance the fabric summaries were computed at
  source: 'photo',    // which set of colors the results come from: 'photo' or 'fabrics'
  sizes: new Set([2, 3, 4]),
  shopFilter: null,
  tol: 8,
  minCov: 0.004,
  purity: 0.65,
};

const $ = (id) => document.getElementById(id);
const photo = $('photo'), overlay = $('overlay'), pop = $('pop');

// ---------- analysis ----------

// Quantize an RGB buffer to 6 bits per channel so identical-looking pixels share
// one ΔE computation, then measure every unique color against every book color.
// skipEdges drops pixels where two scraps meet; patterned fabric keeps them.
function analyzePixels(c, w, h, skipEdges) {
  const n = w * h;
  const keyToU = new Int32Array(1 << 18).fill(-1);
  const pxU = new Int32Array(n).fill(-1);    // pixel -> unique color index, -1 if skipped
  const rgb = [];
  const counts = [];
  for (let i = 0; i < n; i++) {
    if (skipEdges) {
      const x = i % w, y = (i - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) continue;
      let diff = 0;
      for (let k = 0; k < 3; k++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += c[(i + dy * w + dx) * 3 + k];
        diff += Math.abs(c[i * 3 + k] - sum / 9);
      }
      if (diff > EDGE) continue;
    }
    const r = c[i * 3] >> 2, g = c[i * 3 + 1] >> 2, b = c[i * 3 + 2] >> 2;
    const key = (r << 12) | (g << 6) | b;
    let u = keyToU[key];
    if (u < 0) { u = keyToU[key] = counts.length; counts.push(0); rgb.push(r * 4 + 2, g * 4 + 2, b * 4 + 2); }
    counts[u]++;
    pxU[i] = u;
  }
  const U = counts.length;
  const dist = new Float32Array(NC * U);     // dist[j * U + u] = ΔE between book color j and unique color u
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
  return { pxU, U, uCount: Uint32Array.from(counts), dist, best, bestJ, total: n };
}

// Does unique color u of analysis A count toward book color j? Pixels whose
// best match is ignored (e.g. the tabletop) are dropped entirely.
function matches(A, u, j, ignored) {
  const d = A.dist[j * A.U + u];
  return d < S.tol && d <= A.best[u] + MARGIN && !(ignored && ignored.has(A.bestJ[u]));
}

// ---------- pile photo ----------

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
    S.source = 'photo';
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

function applyWb(imageData, wb) {
  if (wb.every((k) => k === 1)) return;
  const p = imageData.data;
  for (let i = 0; i < p.length; i += 4) {
    p[i] = corrected(p[i], wb[0]);
    p[i + 1] = corrected(p[i + 1], wb[1]);
    p[i + 2] = corrected(p[i + 2], wb[2]);
  }
}

function drawPhoto() {
  const img = S.img;
  const s = Math.min(1, DISPLAY_MAX / Math.max(img.naturalWidth, img.naturalHeight));
  photo.width = overlay.width = Math.round(img.naturalWidth * s);
  photo.height = overlay.height = Math.round(img.naturalHeight * s);
  const ctx = photo.getContext('2d');
  ctx.drawImage(img, 0, 0, photo.width, photo.height);
  if (S.wb.some((k) => k !== 1)) {
    const d = ctx.getImageData(0, 0, photo.width, photo.height);
    applyWb(d, S.wb);
    ctx.putImageData(d, 0, 0);
  }
  clearMask();
}

function analyze() {
  drawPhoto();
  const n = S.w * S.h, p = S.raw.data;
  const c = new Uint8ClampedArray(n * 3);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) c[i * 3 + k] = corrected(p[i * 4 + k], S.wb[k]);
  }
  S.A = analyzePixels(c, S.w, S.h, true);
  update();
}

function computeCoverage() {
  const A = S.A;
  for (let j = 0; j < NC; j++) {
    let sum = 0;
    for (let u = 0; u < A.U; u++) if (matches(A, u, j, S.ignored)) sum += A.uCount[u];
    S.coverage[j] = sum / A.total;
  }
}

// For one combo, give each pixel to the closest of the combo's colors, so a
// single red scrap can't count as both "Carmine" and "Spectrum Red".
function evalCombo(combo) {
  const { A, minCov } = S;
  const cs = combo.colors;
  const usable = cs.filter((j) => !S.ignored.has(j));
  const amount = new Map(cs.map((j) => [j, 0]));
  if (usable.length) {
    for (let u = 0; u < A.U; u++) {
      let best = -1, bd = Infinity;
      for (const j of usable) {
        const d = A.dist[j * A.U + u];
        if (d < bd && matches(A, u, j, S.ignored)) { bd = d; best = j; }
      }
      if (best >= 0) amount.set(best, amount.get(best) + A.uCount[u]);
    }
  }
  const missing = [];
  let score = Infinity;
  for (const j of cs) {
    const frac = amount.get(j) / A.total;
    const have = !S.ignored.has(j) && (S.added.has(j) || frac >= minCov);
    if (have) score = Math.min(score, S.added.has(j) ? Math.max(frac, minCov) : frac);
    else missing.push(j);
  }
  return { combo, missing, score };
}

// ---------- fabric library ----------

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Crop a region of an image into a small JPEG swatch, with white balance applied.
function makeSwatch(img, sx, sy, sw, sh, wb) {
  const s = Math.min(1, FABRIC_MAX / Math.max(sw, sh));
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(sw * s));
  cv.height = Math.max(1, Math.round(sh * s));
  const ctx = cv.getContext('2d');
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
  const d = ctx.getImageData(0, 0, cv.width, cv.height);
  applyWb(d, wb);
  ctx.putImageData(d, 0, 0);
  return cv.toDataURL('image/jpeg', 0.9);
}

async function analyzeFabric(f) {
  const img = await loadImage(f.thumb);
  const cv = document.createElement('canvas');
  cv.width = img.naturalWidth; cv.height = img.naturalHeight;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const p = ctx.getImageData(0, 0, cv.width, cv.height).data;
  const c = new Uint8ClampedArray((p.length / 4) * 3);
  for (let i = 0, o = 0; i < p.length; i += 4, o += 3) { c[o] = p[i]; c[o + 1] = p[i + 1]; c[o + 2] = p[i + 2]; }
  f.A = analyzePixels(c, cv.width, cv.height, false);
  summarizeFabric(f);
}

// Group a fabric's pixels by the book colors they could pass for (closest first),
// so checking a combo is a pass over a few dozen groups instead of every pixel.
function summarizeFabric(f) {
  const A = f.A, groups = new Map(), share = new Float32Array(NC);
  let matched = 0;
  for (let u = 0; u < A.U; u++) {
    if (A.best[u] >= S.tol) continue;
    const n = A.uCount[u];
    matched += n;
    share[A.bestJ[u]] += n;
    const cands = [];
    for (let j = 0; j < NC; j++) if (matches(A, u, j)) cands.push(j);
    cands.sort((p, q) => A.dist[p * A.U + u] - A.dist[q * A.U + u]);
    const key = cands.join(',');
    groups.set(key, (groups.get(key) || 0) + n);
  }
  f.groups = [...groups].map(([k, n]) => [k.split(',').map(Number), n]);
  f.matched = matched;
  f.share = share.map((v) => (matched ? v / matched : 0));
}

function usableFabrics() {
  return S.fabrics.filter((f) => f.on && f.groups && f.matched / f.A.total >= MIN_MATCHED);
}

// A fabric can join a combo only if most of it (S.purity) is in the combo's
// colors, so a busy print with off-palette colors stays out. It then provides
// every combo color that is at least LEAD of it: a two-color stripe can provide both.
function evalComboFabrics(combo, fabrics) {
  const cs = combo.colors, inCombo = new Set(cs);
  const providers = new Map(cs.map((j) => [j, []]));
  for (const f of fabrics) {
    const amount = new Map(cs.map((j) => [j, 0]));
    let inside = 0;
    for (const [cands, n] of f.groups) {
      const j = cands.find((k) => inCombo.has(k));
      if (j !== undefined) { amount.set(j, amount.get(j) + n); inside += n; }
    }
    if (inside / f.matched < S.purity) continue;
    for (const j of cs) {
      const s = amount.get(j) / f.matched;
      if (s >= LEAD) providers.get(j).push({ f, s });
    }
  }
  const missing = [];
  let score = Infinity;
  for (const j of cs) {
    const list = providers.get(j).sort((p, q) => q.s - p.s);
    if (list.length) score = Math.min(score, list[0].s);
    else missing.push(j);
  }
  return { combo, missing, score, providers };
}

function nextFabricName() {
  let n = S.fabrics.length + 1;
  while (S.fabrics.some((f) => f.name === `Fabric ${n}`)) n++;
  return `Fabric ${n}`;
}

function saveFabrics() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(S.fabrics.map(({ id, name, thumb, on }) => ({ id, name, thumb, on }))));
  } catch {
    toast('Could not save fabrics in this browser');
  }
}

async function restoreFabrics() {
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY)) || []; } catch { /* private mode or bad data */ }
  S.fabrics = saved.map((f) => ({ ...f, A: null }));
  await Promise.all(S.fabrics.map((f) => analyzeFabric(f).catch(() => {})));
  S.fabTol = S.tol;
  if (S.fabrics.length && !S.A) S.source = 'fabrics';
  update();
}

async function addFabric(thumb, name) {
  const f = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, thumb, on: true, A: null };
  await analyzeFabric(f);
  S.fabrics.push(f);
  saveFabrics();
  if (S.fabrics.length === 1) S.source = 'fabrics';
  update();
}

async function addFabricFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImage(url);
      // The fabric should fill the frame; trim the borders in case a bit of table shows.
      const W = img.naturalWidth, H = img.naturalHeight, m = 0.1;
      await addFabric(makeSwatch(img, W * m, H * m, W * (1 - 2 * m), H * (1 - 2 * m), [1, 1, 1]), nextFabricName());
    } catch {
      toast('Could not read ' + file.name);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

// ---------- update ----------

function update() {
  if (S.fabTol !== S.tol) {
    for (const f of S.fabrics) if (f.A) summarizeFabric(f);
    S.fabTol = S.tol;
  }
  if (S.source === 'fabrics' && !S.fabrics.length && S.A) S.source = 'photo';
  if (S.source === 'photo' && !S.A && S.fabrics.length) S.source = 'fabrics';
  syncLayout();
  renderFabrics();
  if (S.A) { computeCoverage(); renderPalette(); }

  const ready = S.source === 'photo' ? !!S.A : S.fabrics.length > 0;
  $('empty').hidden = ready;
  $('results').hidden = !ready;
  if (!ready) return;

  const fabrics = usableFabrics();
  const evaluate = S.source === 'photo' ? evalCombo : (c) => evalComboFabrics(c, fabrics);
  const results = WCOMBOS.filter((c) => S.sizes.has(c.colors.length)).map(evaluate);
  const bySizeThenScore = (p, q) => q.combo.colors.length - p.combo.colors.length || q.score - p.score;
  const have = results.filter((r) => r.missing.length === 0).sort(bySizeThenScore);
  const near = results.filter((r) => r.missing.length === 1).sort(bySizeThenScore);

  renderShop(near);
  if (S.shopFilter !== null && !near.some((r) => r.missing[0] === S.shopFilter)) S.shopFilter = null;
  const nearShown = S.shopFilter === null ? near : near.filter((r) => r.missing[0] === S.shopFilter);
  const tip = S.source === 'photo' ? 'Try raising the tolerance or lowering the minimum amount.'
    : 'Try raising the tolerance, lowering the fabric fit, or adding more fabrics.';
  renderGrid($('have'), have, 'None yet. ' + tip);
  renderGrid($('near'), nearShown, 'Nothing here with the current settings.');
  $('haveCount').textContent = have.length;
  $('nearCount').textContent = near.length;
}

function syncLayout() {
  const hasPhoto = !!S.A, hasFabrics = S.fabrics.length > 0;
  $('drop').hidden = hasPhoto;
  $('stage').hidden = !hasPhoto;
  $('hint').hidden = !hasPhoto;
  $('paletteBox').hidden = !hasPhoto;
  $('photoButtons').hidden = !hasPhoto;
  $('controls').hidden = !hasPhoto && !hasFabrics;
  $('covRow').hidden = S.source !== 'photo';
  $('fitRow').hidden = S.source !== 'fabrics';
  $('fabCount').textContent = hasFabrics ? S.fabrics.length : '';
  for (const b of document.querySelectorAll('#sourceSeg button')) {
    b.disabled = b.dataset.source === 'photo' ? !hasPhoto : !hasFabrics;
    b.classList.toggle('active', b.dataset.source === S.source);
  }
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

function renderFabrics() {
  const box = $('fabrics');
  box.replaceChildren();
  for (const f of S.fabrics) {
    const tile = el('div', 'fab' + (f.on ? '' : ' off'));
    tile.dataset.id = f.id;
    const img = el('img');
    img.src = f.thumb;
    img.alt = '';

    const info = el('div', 'fab-info');
    const name = el('input', 'fab-name');
    name.value = f.name;
    name.setAttribute('aria-label', 'Fabric name');
    name.onchange = () => { f.name = name.value.trim() || f.name; saveFabrics(); };
    const bar = el('div', 'fab-bar');
    let caption = 'Analyzing…';
    if (f.share) {
      const top = [...f.share.keys()].filter((j) => f.share[j] >= 0.04).sort((p, q) => f.share[q] - f.share[p]).slice(0, 6);
      for (const j of top) {
        const seg = el('i');
        seg.style.background = WCOLORS[j].hex;
        seg.style.flexGrow = f.share[j];
        seg.title = `${WCOLORS[j].name} ${pct(f.share[j])}`;
        bar.append(seg);
      }
      caption = f.matched / f.A.total < MIN_MATCHED
        ? 'Colors too far from the book (skipped)'
        : top.slice(0, 3).map((j) => `${WCOLORS[j].name} ${pct(f.share[j])}`).join(' · ');
    }
    info.append(name, bar, el('div', 'fab-colors', caption));

    const use = el('input');
    use.type = 'checkbox';
    use.checked = f.on;
    use.title = 'Use this fabric in combos';
    use.onchange = () => { f.on = use.checked; saveFabrics(); update(); };
    const del = el('button', 'x', '×');
    del.type = 'button';
    del.title = 'Remove fabric';
    del.onclick = () => {
      if (!confirm(`Remove ${f.name}?`)) return;
      S.fabrics = S.fabrics.filter((x) => x !== f);
      saveFabrics();
      update();
    };
    const actions = el('div', 'fab-actions');
    actions.append(use, del);
    tile.append(img, info, actions);
    box.append(tile);
  }
}

function highlightFabrics(ids) {
  for (const t of document.querySelectorAll('.fab')) t.classList.toggle('lit', ids.has(t.dataset.id));
}

function fabricThumbs(list, cls) {
  const box = el('span', cls);
  for (const { f, s } of list) {
    const img = el('img');
    img.src = f.thumb;
    img.alt = f.name;
    img.title = `${f.name} (${pct(s)})`;
    box.append(img);
  }
  return box;
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
  for (const r of results) {
    const { combo, missing, providers } = r;
    const card = el('article', 'card');
    const head = el('div', 'card-head');
    const share = el('button', 'share', 'Copy image');
    share.type = 'button';
    share.title = 'Copy this combo as an image with its color codes';
    share.onclick = (e) => { e.stopPropagation(); shareCombo(combo, missing); };
    head.append(el('span', 'num', 'No. ' + String(combo.id).padStart(3, '0')), share);
    card.append(head);
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
      li.append(sw, el('span', 'nm', WCOLORS[j].name));
      if (providers && providers.get(j).length) li.append(fabricThumbs(providers.get(j).slice(0, 3), 'mini-fabs'));
      names.append(li);
    }
    card.append(bands, names);
    if (providers) {
      const ids = new Set([...providers.values()].flat().map((p) => p.f.id));
      card.onmouseenter = () => highlightFabrics(ids);
      card.onmouseleave = () => highlightFabrics(new Set());
    } else {
      const present = combo.colors.filter((j) => !missing.includes(j));
      card.onmouseenter = () => showMask(present);
      card.onmouseleave = clearMask;
    }
    card.onclick = () => openCombo(r);
    card.tabIndex = 0;
    card.title = 'Open color details';
    card.onkeydown = (e) => {
      if (e.target === card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openCombo(r); }
    };
    frag.append(card);
  }
  box.append(frag);
}

// ---------- sharing ----------

function cmykLabel(j) {
  const [c, m, y, k] = WCOLORS[j].cmyk;
  return `C${c} M${m} Y${y} K${k}`;
}

async function comboImage(combo, missing, type) {
  await Promise.all(['italic 34px', '500 30px'].map((f) => document.fonts.load(f + ' "EB Garamond"'))).catch(() => {});
  const W = 1200, pad = 64, headH = 64, bandH = 520, rowH = 66, footH = 84;
  const n = combo.colors.length;
  const H = pad + headH + bandH + 28 + n * rowH + footH;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const x = cv.getContext('2d');
  const serif = '"EB Garamond", Georgia, serif', sans = '-apple-system, "Segoe UI", Helvetica, Arial, sans-serif';

  x.fillStyle = '#f6f3ec';
  x.fillRect(0, 0, W, H);
  x.fillStyle = '#7a756b';
  x.font = `italic 34px ${serif}`;
  x.fillText('No. ' + String(combo.id).padStart(3, '0'), pad, pad + 32);

  const bw = (W - 2 * pad) / n;
  combo.colors.forEach((j, i) => {
    x.fillStyle = WCOLORS[j].hex;
    x.fillRect(Math.round(pad + i * bw), pad + headH, Math.ceil(bw), bandH);
  });

  let y = pad + headH + bandH + 28;
  for (const j of combo.colors) {
    const mid = y + rowH / 2;
    x.beginPath();
    x.arc(pad + 18, mid, 18, 0, TAU);
    x.fillStyle = WCOLORS[j].hex;
    x.fill();
    x.strokeStyle = 'rgba(0,0,0,.15)';
    x.lineWidth = 1.5;
    x.stroke();
    x.textBaseline = 'middle';
    x.textAlign = 'left';
    x.fillStyle = '#2b2925';
    x.font = `500 32px ${serif}`;
    x.fillText(WCOLORS[j].name, pad + 54, mid);
    if (missing.includes(j)) {
      const w = x.measureText(WCOLORS[j].name).width;
      x.fillStyle = '#8a3b2e';
      x.font = `600 20px ${sans}`;
      x.fillText('NEED', pad + 54 + w + 16, mid + 1);
    }
    x.textAlign = 'right';
    x.fillStyle = '#5c574e';
    x.font = `22px ui-monospace, Menlo, Consolas, monospace`;
    x.fillText(`${WCOLORS[j].hex.toUpperCase()}   ${cmykLabel(j)}`, W - pad, mid);
    x.fillStyle = '#e2ddd2';
    x.fillRect(pad, y + rowH - 1, W - 2 * pad, 1);
    y += rowH;
  }

  x.textAlign = 'left';
  x.textBaseline = 'alphabetic';
  x.fillStyle = '#7a756b';
  x.font = `italic 24px ${serif}`;
  x.fillText('A Dictionary of Color Combinations · Sanzo Wada', pad, H - pad + 16);
  if (location.protocol.startsWith('http')) {
    x.textAlign = 'right';
    x.font = `20px ${sans}`;
    x.fillText(location.host + location.pathname.replace(/index\.html$/, ''), W - pad, H - pad + 14);
  }
  return new Promise((resolve) => cv.toBlob(resolve, type, 0.92));
}

// Browsers only put PNG on the clipboard; where that isn't allowed, fall back
// to the share sheet (phones) or a JPEG download.
function shareCombo(combo, missing) {
  const name = `wada-combo-${String(combo.id).padStart(3, '0')}.jpg`;
  const fallback = async () => {
    const blob = await comboImage(combo, missing, 'image/jpeg');
    const file = new File([blob], name, { type: 'image/jpeg' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Saved ' + name);
  };
  if (!navigator.clipboard || !window.ClipboardItem) { fallback(); return; }
  // The ClipboardItem must be created synchronously inside the click for Safari.
  const item = new ClipboardItem({ 'image/png': comboImage(combo, missing, 'image/png') });
  navigator.clipboard.write([item]).then(() => toast('Image copied. Paste it anywhere.'), fallback);
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(() => toast('Copied ' + text), () => toast('Could not copy'));
}

// Same layout as the shared image, but live: click a code to copy it.
function openCombo({ combo, missing, providers }) {
  const dlg = $('comboDialog');
  const body = el('div', 'dlg-body');
  const head = el('div', 'dlg-head');
  const close = el('button', 'x', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.onclick = () => dlg.close();
  head.append(el('span', 'num', 'No. ' + String(combo.id).padStart(3, '0')), close);

  const bands = el('div', 'dlg-bands');
  const rows = el('ul', 'dlg-rows');
  for (const j of combo.colors) {
    const isMissing = missing.includes(j);
    const band = el('div', 'band');
    band.style.background = WCOLORS[j].hex;
    bands.append(band);

    const li = el('li');
    const sw = el('i', 'sw');
    sw.style.background = WCOLORS[j].hex;
    const name = el('span', 'nm');
    const title = el('span', '', WCOLORS[j].name);
    if (isMissing) title.append(el('b', 'need', 'NEED'));
    name.append(title);
    if (providers && providers.get(j).length) {
      const fabs = el('span', 'dlg-fabs');
      for (const p of providers.get(j)) {
        const item = el('span', 'dlg-fab');
        item.append(fabricThumbs([p], 'mini-fabs'), `${p.f.name} · ${pct(p.s)}`);
        fabs.append(item);
      }
      name.append(fabs);
    }
    const codes = el('span', 'codes');
    for (const code of [WCOLORS[j].hex.toUpperCase(), cmykLabel(j)]) {
      const b = el('button', 'code', code);
      b.type = 'button';
      b.title = 'Copy';
      b.onclick = () => copyText(code);
      codes.append(b);
    }
    li.append(sw, name, codes);
    rows.append(li);
  }

  const actions = el('div', 'dlg-actions');
  const share = el('button', 'share', 'Copy image');
  share.type = 'button';
  share.onclick = () => shareCombo(combo, missing);
  actions.append(share);

  body.append(head, bands, rows, actions);
  dlg.replaceChildren(body);
  dlg.showModal();
}

$('comboDialog').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close(); // backdrop click
});

let toastTimer = 0;
function toast(msg) {
  let t = $('toast');
  if (!t) { t = el('div', 'toast'); t.id = 'toast'; }
  // An open modal dialog sits in the top layer, so the toast must live inside it to be seen.
  const host = document.querySelector('dialog[open]') || document.body;
  if (t.parentNode !== host) host.append(t);
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------- photo overlay ----------

const maskCanvas = document.createElement('canvas');

function showMask(js) {
  if (!S.A || !js.length) return;
  const { w, h } = S, A = S.A;
  maskCanvas.width = w; maskCanvas.height = h;
  const mctx = maskCanvas.getContext('2d');
  const d = mctx.createImageData(w, h);
  const hit = new Uint8Array(A.U);
  for (let u = 0; u < A.U; u++) for (const j of js) if (matches(A, u, j, S.ignored)) { hit[u] = 1; break; }
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    d.data[o] = d.data[o + 1] = d.data[o + 2] = 20;
    d.data[o + 3] = A.pxU[i] >= 0 && hit[A.pxU[i]] ? 0 : 200;
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
function sampleAt(evt, withWb) {
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
  if (withWb) { r = corrected(r, S.wb[0]); g = corrected(g, S.wb[1]); b = corrected(b, S.wb[2]); }
  return [r, g, b];
}

function popHead(title, onClose) {
  const head = el('div', 'pop-head');
  head.append(el('span', '', title));
  const close = el('button', 'x', '×');
  close.type = 'button';
  close.onclick = () => { pop.hidden = true; if (onClose) onClose(); };
  head.append(close);
  return head;
}

function placePop(evt) {
  const stage = $('stage').getBoundingClientRect();
  pop.hidden = false;
  const x = Math.min(evt.clientX - stage.left + 12, stage.width - pop.offsetWidth - 4);
  const y = Math.min(evt.clientY - stage.top + 12, stage.height - pop.offsetHeight - 4);
  pop.style.left = Math.max(4, x) + 'px';
  pop.style.top = Math.max(4, y) + 'px';
}

// Click: identify a color. Drag: box a scrap and save it as a fabric.
let drag = null, suppressClick = false;

function relPos(evt) {
  const r = overlay.getBoundingClientRect();
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  return [clamp01((evt.clientX - r.left) / r.width), clamp01((evt.clientY - r.top) / r.height)];
}

function selectionRect(d) {
  return { x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0) };
}

function drawSelection(d) {
  const { x, y, w, h } = selectionRect(d);
  const W = overlay.width, H = overlay.height;
  const octx = overlay.getContext('2d');
  octx.clearRect(0, 0, W, H);
  octx.fillStyle = 'rgba(20,18,15,.45)';
  octx.fillRect(0, 0, W, H);
  octx.clearRect(x * W, y * H, w * W, h * H);
  octx.setLineDash([8, 6]);
  octx.lineWidth = 2;
  octx.strokeStyle = '#fff';
  octx.strokeRect(x * W, y * H, w * W, h * H);
  octx.setLineDash([]);
}

overlay.addEventListener('pointerdown', (evt) => {
  if (!S.A || S.wbMode || evt.button !== 0) return;
  const [x, y] = relPos(evt);
  drag = { x0: x, y0: y, x1: x, y1: y, moved: false };
  overlay.setPointerCapture(evt.pointerId);
});

overlay.addEventListener('pointermove', (evt) => {
  if (!drag) return;
  [drag.x1, drag.y1] = relPos(evt);
  const r = overlay.getBoundingClientRect();
  if (Math.abs(drag.x1 - drag.x0) * r.width > 8 || Math.abs(drag.y1 - drag.y0) * r.height > 8) drag.moved = true;
  if (drag.moved) drawSelection(drag);
});

overlay.addEventListener('pointercancel', () => { drag = null; clearMask(); });

overlay.addEventListener('pointerup', (evt) => {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (!d.moved) return;
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 0);
  showSavePop(d, evt);
});

function showSavePop(d, evt) {
  const { x, y, w, h } = selectionRect(d);
  const iw = S.img.naturalWidth, ih = S.img.naturalHeight;
  const thumb = makeSwatch(S.img, x * iw, y * ih, w * iw, h * ih, S.wb);
  pop.replaceChildren(popHead('Save as fabric', clearMask));
  const row = el('div', 'pop-save');
  const img = el('img');
  img.src = thumb;
  img.alt = '';
  const name = el('input', 'fab-name');
  name.value = nextFabricName();
  name.setAttribute('aria-label', 'Fabric name');
  const save = el('button', 'add', 'Save');
  save.type = 'button';
  save.onclick = async () => {
    pop.hidden = true;
    clearMask();
    const label = name.value.trim() || nextFabricName();
    await addFabric(thumb, label);
    toast(`Saved ${label} to My fabrics`);
  };
  name.onkeydown = (e) => { if (e.key === 'Enter') save.click(); };
  row.append(img, name, save);
  pop.append(row);
  placePop(evt);
  name.select();
}

overlay.addEventListener('click', (evt) => {
  if (!S.raw || suppressClick) return;
  if (S.wbMode) {
    const [r, g, b] = sampleAt(evt, false);
    const clamp = (k) => Math.min(4, Math.max(0.5, k));
    S.wb = [clamp(240 / Math.max(r, 1)), clamp(240 / Math.max(g, 1)), clamp(240 / Math.max(b, 1))];
    setWbMode(false);
    $('wbReset').hidden = false;
    analyze();
    return;
  }
  clearMask();
  const rgb = sampleAt(evt, true);
  const top = nearestWada(srgbToLab(...rgb)).slice(0, 4);
  const head = popHead('Closest book colors');
  const sw = el('i', 'sw');
  sw.style.background = `rgb(${rgb.map(Math.round).join(',')})`;
  head.prepend(sw);
  pop.replaceChildren(head);
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
  placePop(evt);
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
  $('fitOut').textContent = `≥ ${Math.round(S.purity * 100)}% in the combo's colors`;
}

let pending = 0;
function scheduleUpdate() {
  cancelAnimationFrame(pending);
  pending = requestAnimationFrame(update);
}

$('tol').addEventListener('input', (e) => { S.tol = +e.target.value; syncOutputs(); scheduleUpdate(); });
$('cov').addEventListener('input', (e) => { S.minCov = e.target.value / 100; syncOutputs(); scheduleUpdate(); });
$('fit').addEventListener('input', (e) => { S.purity = e.target.value / 100; syncOutputs(); scheduleUpdate(); });
$('wbBtn').addEventListener('click', () => setWbMode(!S.wbMode));
$('wbReset').addEventListener('click', () => { S.wb = [1, 1, 1]; $('wbReset').hidden = true; analyze(); });
$('newPhoto').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });
$('addFabric').addEventListener('click', () => $('fabFile').click());
$('fabFile').addEventListener('change', (e) => { addFabricFiles([...e.target.files]); e.target.value = ''; });
for (const b of document.querySelectorAll('#sourceSeg button')) {
  b.addEventListener('click', () => { S.source = b.dataset.source; S.shopFilter = null; update(); });
}
document.querySelectorAll('input[name=size]').forEach((cb) => cb.addEventListener('change', () => {
  if (cb.checked) S.sizes.add(+cb.value); else S.sizes.delete(+cb.value);
  update();
}));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { pop.hidden = true; setWbMode(false); clearMask(); }
});

const left = document.querySelector('.left');
left.addEventListener('dragover', (e) => { e.preventDefault(); left.classList.add('dragging'); });
left.addEventListener('dragleave', () => left.classList.remove('dragging'));
left.addEventListener('drop', (e) => {
  e.preventDefault();
  left.classList.remove('dragging');
  loadFile(e.dataTransfer.files[0]);
});
const fabricBox = $('fabricBox');
fabricBox.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); fabricBox.classList.add('dragging'); });
fabricBox.addEventListener('dragleave', () => fabricBox.classList.remove('dragging'));
fabricBox.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  fabricBox.classList.remove('dragging');
  addFabricFiles([...e.dataTransfer.files]);
});

S.tol = +$('tol').value;
S.minCov = $('cov').value / 100;
S.purity = $('fit').value / 100;
syncOutputs();
restoreFabrics();
