'use strict';
/* =====================================================================
   SINOON 웹 카메라 글자 인식
   - PaddleOCR(PP-OCRv4) 모델을 휴대폰 브라우저 안에서 직접 돌립니다.
     사진은 어디로도 보내지지 않아요.
   - 모델·실행도구(약 27MB)는 처음 한 번만 받아 휴대폰(브라우저 저장소)에 보관하고,
     그 뒤로는 인터넷 없이 보관된 것으로 켭니다.
   ===================================================================== */
const OCR = (() => {
  const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
  const MODEL_BASE = 'https://cdn.jsdelivr.net/npm/@gutenye/ocr-models@1.4.2/assets/';
  const FILES = {
    det: MODEL_BASE + 'ch_PP-OCRv4_det_infer.onnx',
    rec: MODEL_BASE + 'ch_PP-OCRv4_rec_infer.onnx',
    keys: MODEL_BASE + 'ppocr_keys_v1.txt',
    wasm: ORT_BASE + 'ort-wasm-simd-threaded.wasm',
  };
  // 받아서 휴대폰에 보관할 파일(실행 도구 + 모델)과 크기
  const CACHE_NAME = 'sinoon-ocr-v1';
  const PARTS = [
    { url: ORT_BASE + 'ort.wasm.min.js', size: 49026, type: 'text/javascript' },
    { url: ORT_BASE + 'ort-wasm-simd-threaded.mjs', size: 24618, type: 'text/javascript' },
    { url: FILES.wasm, size: 11246032, type: 'application/wasm' },
    { url: FILES.det, size: 4745517, type: 'application/octet-stream' },
    { url: FILES.rec, size: 10822323, type: 'application/octet-stream' },
    { url: FILES.keys, size: 26249, type: 'text/plain' },
  ];
  const TOTAL = PARTS.reduce((a, p) => a + p.size, 0);

  let readyPromise = null, det = null, rec = null, KEYS = null;

  async function openCache() {
    try { return 'caches' in self ? await caches.open(CACHE_NAME) : null; } catch (_) { return null; }
  }
  async function missingParts() {
    const c = await openCache();
    if (!c) return PARTS.slice();
    const out = [];
    for (const p of PARTS) if (!(await c.match(p.url))) out.push(p);
    return out;
  }
  // 휴대폰에 다 받아져 있는지
  async function isDownloaded() { return (await missingParts()).length === 0; }

  async function fetchBuf(url, onBytes) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('다운로드 실패(' + res.status + ')');
    if (!res.body || !res.body.getReader) { const b = await res.arrayBuffer(); onBytes(b.byteLength); return b; }
    const reader = res.body.getReader(), parts = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); n += value.length; onBytes(value.length);
    }
    const out = new Uint8Array(n); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out.buffer;
  }

  // 아직 없는 파일만 받아서 보관합니다. onProgress(받은 바이트, 전체 바이트)
  async function download(onProgress) {
    const c = await openCache();
    const need = await missingParts();
    let got = TOTAL - need.reduce((a, p) => a + p.size, 0);
    onProgress && onProgress(got, TOTAL);
    for (const p of need) {
      let partGot = 0;
      const buf = await fetchBuf(p.url, (n) => { partGot += n; onProgress && onProgress(Math.min(TOTAL, got + partGot), TOTAL); });
      got += p.size;
      if (c) await c.put(p.url, new Response(buf, { headers: { 'content-type': p.type, 'content-length': String(buf.byteLength) } }));
    }
    onProgress && onProgress(TOTAL, TOTAL);
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (_) {}
  }

  async function remove() {
    try { if ('caches' in self) await caches.delete(CACHE_NAME); } catch (_) {}
  }

  async function getBuf(url) {
    const c = await openCache();
    const hit = c && await c.match(url);
    if (hit) return hit.arrayBuffer();
    return fetchBuf(url, () => {});
  }
  async function getText(url) { return new TextDecoder().decode(await getBuf(url)); }

  // 보관된 파일로 인식 도구를 켭니다(인터넷 없어도 됨). 안 받은 게 있으면 먼저 받아요.
  function init(onProgress) {
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
      if (!(await isDownloaded())) await download(onProgress);
      if (!window.ort) {
        const code = await getText(PARTS[0].url);
        const s = document.createElement('script');
        s.textContent = code; document.head.appendChild(s);
        if (!window.ort) throw new Error('인식 도구를 실행하지 못했어요');
      }
      // 실행 도구 모듈도 보관된 것으로 띄웁니다(blob 주소에서는 상대 경로를 못 쓰므로 wasm 주소를 절대 경로로 바꿔둠).
      const mjs = (await getText(PARTS[1].url)).split('new URL("ort-wasm-simd-threaded.wasm",import.meta.url)').join('new URL(' + JSON.stringify(FILES.wasm) + ')');
      const mjsUrl = URL.createObjectURL(new Blob([mjs], { type: 'text/javascript' }));
      const [wasm, d, r, k] = await Promise.all([getBuf(FILES.wasm), getBuf(FILES.det), getBuf(FILES.rec), getBuf(FILES.keys)]);
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.wasmPaths = { mjs: mjsUrl };
      ort.env.wasm.wasmBinary = wasm;
      const opt = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
      det = await ort.InferenceSession.create(new Uint8Array(d), opt);
      rec = await ort.InferenceSession.create(new Uint8Array(r), opt);
      KEYS = ['', ...new TextDecoder().decode(k).split(/\r?\n/), ' '];
      if (KEYS.length > 1 && KEYS[KEYS.length - 2] === '') KEYS.splice(KEYS.length - 2, 1);
    })().catch((e) => { readyPromise = null; throw e; });
    return readyPromise;
  }

  /* ---------------- 이미지 도우미 ---------------- */
  function makeCanvas(w, h) {
    const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
  }
  function pixelsOf(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return { w: canvas.width, h: canvas.height, d: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
  }

  // 원본에서 평행사변형 영역(O, O+A, O+B)을 tw×th 크기로 뽑아 [3, th, tw](BGR) 텐서 값으로 채웁니다.
  function sampleBGR(img, O, A, B, tw, th, out, outW, mean, std) {
    const { w, h, d } = img;
    const la = Math.hypot(A[0], A[1]) / tw, lb = Math.hypot(B[0], B[1]) / th;
    const ss = Math.max(1, Math.min(3, Math.ceil(Math.max(la, lb) - 0.2))); // 크게 줄일 때 계단 현상 방지
    const plane = th * outW;
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        let r = 0, g = 0, b = 0;
        for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
          const fx = (x + (sx + 0.5) / ss) / tw, fy = (y + (sy + 0.5) / ss) / th;
          let px = O[0] + A[0] * fx + B[0] * fy - 0.5, py = O[1] + A[1] * fx + B[1] * fy - 0.5;
          if (px < 0) px = 0; else if (px > w - 1) px = w - 1;
          if (py < 0) py = 0; else if (py > h - 1) py = h - 1;
          const x0 = px | 0, y0 = py | 0, x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
          const ax = px - x0, ay = py - y0;
          const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4, i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
          const w00 = (1 - ax) * (1 - ay), w10 = ax * (1 - ay), w01 = (1 - ax) * ay, w11 = ax * ay;
          r += d[i00] * w00 + d[i10] * w10 + d[i01] * w01 + d[i11] * w11;
          g += d[i00 + 1] * w00 + d[i10 + 1] * w10 + d[i01 + 1] * w01 + d[i11 + 1] * w11;
          b += d[i00 + 2] * w00 + d[i10 + 2] * w10 + d[i01 + 2] * w01 + d[i11 + 2] * w11;
        }
        const n = ss * ss * 255, o = y * outW + x;
        out[o] = (b / n - mean[0]) / std[0];
        out[plane + o] = (g / n - mean[1]) / std[1];
        out[2 * plane + o] = (r / n - mean[2]) / std[2];
      }
    }
  }

  /* ---------------- 글자 위치 찾기(DB 후처리) ---------------- */
  function convexHull(pts) {
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (pts.length < 3) return pts;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    lo.pop(); up.pop();
    return lo.concat(up);
  }

  // 최소 넓이 회전 사각형 {c:[x,y], u:[ux,uy], w, h}  (u 방향 길이 w, 수직 방향 길이 h)
  function minAreaRect(hull) {
    if (hull.length < 3) return null;
    let best = null;
    for (let i = 0; i < hull.length; i++) {
      const p = hull[i], q = hull[(i + 1) % hull.length];
      let ux = q[0] - p[0], uy = q[1] - p[1];
      const L = Math.hypot(ux, uy); if (!L) continue;
      ux /= L; uy /= L;
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const r of hull) {
        const a = r[0] * ux + r[1] * uy, b = -r[0] * uy + r[1] * ux;
        if (a < a0) a0 = a; if (a > a1) a1 = a; if (b < b0) b0 = b; if (b > b1) b1 = b;
      }
      const area = (a1 - a0) * (b1 - b0);
      if (!best || area < best.area) {
        const ca = (a0 + a1) / 2, cb = (b0 + b1) / 2;
        best = { area, c: [ca * ux - cb * uy, ca * uy + cb * ux], u: [ux, uy], w: a1 - a0, h: b1 - b0 };
      }
    }
    return best;
  }

  function rectPoints(r) {
    const [cx, cy] = r.c, [ux, uy] = r.u, vx = -uy, vy = ux, hw = r.w / 2, hh = r.h / 2;
    return [[cx - ux * hw - vx * hh, cy - uy * hw - vy * hh], [cx + ux * hw - vx * hh, cy + uy * hw - vy * hh],
      [cx + ux * hw + vx * hh, cy + uy * hw + vy * hh], [cx - ux * hw + vx * hh, cy - uy * hw + vy * hh]];
  }

  function pointInQuad(x, y, q) {
    let s = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4];
      const c = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
      if (c > 0) { if (s < 0) return false; s = 1; } else if (c < 0) { if (s > 0) return false; s = -1; }
    }
    return true;
  }

  function boxScore(pred, W, H, q) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of q) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(W - 1, Math.ceil(x1)); y1 = Math.min(H - 1, Math.ceil(y1));
    let s = 0, n = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (pointInQuad(x, y, q)) { s += pred[y * W + x]; n++; }
    }
    return n ? s / n : 0;
  }

  async function detect(img, opts) {
    const maxSide = opts.detMax || 960, minSide = opts.detMin || 0;
    let ratio = Math.min(1, maxSide / Math.max(img.w, img.h));
    if (minSide && Math.min(img.w, img.h) * ratio < minSide) ratio = minSide / Math.min(img.w, img.h);
    const W = Math.max(32, Math.round(img.w * ratio / 32) * 32), H = Math.max(32, Math.round(img.h * ratio / 32) * 32);
    const data = new Float32Array(3 * W * H);
    sampleBGR(img, [0, 0], [img.w, 0], [0, img.h], W, H, data, W, [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]);
    const out = await det.run({ [det.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, H, W]) });
    const pred = out[det.outputNames[0]].data;
    if (opts.debug) opts.debug.det = { pred, W, H };
    const thresh = 0.3, boxThresh = opts.boxThresh || 0.5;
    // 이진화 + 2x2 팽창
    const bin = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) bin[i] = pred[i] > thresh ? 1 : 0;
    const mask = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      mask[i] = bin[i] | (x > 0 ? bin[i - 1] : 0) | (y > 0 ? bin[i - W] : 0) | (x > 0 && y > 0 ? bin[i - W - 1] : 0);
    }
    // 연결된 덩어리마다 회전 사각형 구하기
    const seen = new Uint8Array(W * H), stack = new Int32Array(W * H), boxes = [];
    for (let s0 = 0; s0 < W * H && boxes.length < 1000; s0++) {
      if (!mask[s0] || seen[s0]) continue;
      let sp = 0; stack[sp++] = s0; seen[s0] = 1;
      const edge = [];
      while (sp) {
        const i = stack[--sp], x = i % W, y = (i / W) | 0;
        let border = false;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) { if (!dx || !dy) border = true; continue; }
          const j = ny * W + nx;
          if (!mask[j]) { if (!dx || !dy) border = true; continue; }
          if (!seen[j]) { seen[j] = 1; stack[sp++] = j; }
        }
        if (border) edge.push([x, y]);
      }
      const r = minAreaRect(convexHull(edge));
      if (!r || Math.min(r.w, r.h) < 3) continue;
      const score = boxScore(pred, W, H, rectPoints(r));
      if (score < boxThresh) continue;
      const dist = (r.w * r.h * 1.6) / (2 * (r.w + r.h));
      const ex = { c: r.c, u: r.u, w: r.w + 2 * dist, h: r.h + 2 * dist };
      if (Math.min(ex.w, ex.h) < 5) continue;
      const sx = img.w / W, sy = img.h / H;
      const [p0, p1, , p3] = rectPoints(ex).map(([x, y]) => [x * sx, y * sy]);
      // 사각형의 두 변 E1(=u 방향), E2(=수직 방향)
      boxes.push({ P: p0, E1: [p1[0] - p0[0], p1[1] - p0[1]], E2: [p3[0] - p0[0], p3[1] - p0[1]], score });
    }
    boxes.sort((a, b) => center(a)[1] - center(b)[1] || center(a)[0] - center(b)[0]);
    return boxes;
  }

  /* ---------------- 읽는 방향 정하기 + 글자 읽기 ---------------- */
  const len = (v) => Math.hypot(v[0], v[1]);
  const center = (bx) => [bx.P[0] + (bx.E1[0] + bx.E2[0]) / 2, bx.P[1] + (bx.E1[1] + bx.E2[1]) / 2];

  // 긴 글줄들의 방향으로 사진 전체의 "글 읽는 방향"을 정합니다(라벨이 옆으로 누워 있어도 OK).
  function globalAxis(boxes) {
    let sx = 0, sy = 0;
    for (const b of boxes) {
      const l1 = len(b.E1), l2 = len(b.E2), L = l1 >= l2 ? b.E1 : b.E2, r = Math.max(l1, l2) / Math.max(1, Math.min(l1, l2));
      if (r < 2) continue;
      const ang = Math.atan2(L[1], L[0]), wgt = Math.max(l1, l2);
      sx += Math.cos(2 * ang) * wgt; sy += Math.sin(2 * ang) * wgt;
    }
    if (!sx && !sy) return [1, 0];
    const ang = Math.atan2(sy, sx) / 2;
    let g = [Math.cos(ang), Math.sin(ang)];
    if (g[0] < -1e-6 || (Math.abs(g[0]) <= 1e-6 && g[1] < 0)) g = [-g[0], -g[1]];
    return g;
  }

  // 상자 하나를 "읽기 좌표"로: O(왼쪽 위), A(글 방향 전체 길이), B(아래 방향 전체 높이)
  function cropGeometry(bx, G) {
    const l1 = len(bx.E1), l2 = len(bx.E2), r = Math.max(l1, l2) / Math.max(1, Math.min(l1, l2));
    let R;
    if (r >= 2) R = l1 >= l2 ? bx.E1 : bx.E2;
    else R = Math.abs(bx.E1[0] * G[0] + bx.E1[1] * G[1]) / l1 >= Math.abs(bx.E2[0] * G[0] + bx.E2[1] * G[1]) / l2 ? bx.E1 : bx.E2;
    const Rl = len(R), D = R === bx.E1 ? bx.E2 : bx.E1, Dl = len(D);
    let u = [R[0] / Rl, R[1] / Rl];
    if (u[0] * G[0] + u[1] * G[1] < 0) u = [-u[0], -u[1]];
    const v = [-u[1], u[0]], c = center(bx);
    return { O: [c[0] - u[0] * Rl / 2 - v[0] * Dl / 2, c[1] - u[1] * Rl / 2 - v[1] * Dl / 2], A: [u[0] * Rl, u[1] * Rl], B: [v[0] * Dl, v[1] * Dl], w: Rl, h: Dl, long: r >= 2 };
  }
  const flip = (g) => ({ ...g, O: [g.O[0] + g.A[0] + g.B[0], g.O[1] + g.A[1] + g.B[1]], A: [-g.A[0], -g.A[1]], B: [-g.B[0], -g.B[1]] });

  async function readText(img, g) {
    const tw = Math.max(8, Math.min(1600, Math.ceil(48 * g.w / g.h)));
    const data = new Float32Array(3 * 48 * tw);
    sampleBGR(img, g.O, g.A, g.B, tw, 48, data, tw, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
    const out = await rec.run({ [rec.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, 48, tw]) });
    const t = out[rec.outputNames[0]], [, T, C] = t.dims, p = t.data;
    let text = '', conf = 0, n = 0, prev = -1;
    for (let i = 0; i < T; i++) {
      let bi = 0, bv = -1;
      for (let c = 0; c < C; c++) { const v = p[i * C + c]; if (v > bv) { bv = v; bi = c; } }
      if (bi !== 0 && bi !== prev) { text += KEYS[bi] || ''; conf += bv; n++; }
      prev = bi;
    }
    return { text, score: n ? conf / n : 0 };
  }

  // canvas(사진) → [{text, score, g(읽기 좌표: O 왼쪽 위, A 글 방향, B 아래 방향)}]
  async function recognize(canvas, opts = {}) {
    await init();
    const img = pixelsOf(canvas);
    const t0 = performance.now();
    const boxes = await detect(img, opts);
    const t1 = performance.now();
    const G = globalAxis(boxes);
    const geos = boxes.map(b => cropGeometry(b, G));
    // 0/180 판별: 한 라벨의 글은 모두 같은 방향입니다. 긴 글줄 몇 개를 양쪽 방향으로 읽어보고
    // 더 또렷하게 읽히는 쪽으로 사진 전체 방향을 정합니다. (똑바로 든 사진은 웬만하면 뒤집지 않음)
    const cache = new Map();
    // (영문·숫자로 읽히는 줄만 따집니다. 한글 줄은 이 모델이 못 읽고, 'Sinoon' 로고는 뒤집어도 비슷해 보여서 뺍니다)
    const latin = (r) => {
      const t = r.text.replace(/\s/g, '');
      if (t.length < 3 || /^(S[I1]N[O0][O0]N?|U[O0][O0]U[I1]S?)/i.test(t)) return 0;
      return (t.match(/[A-Za-z0-9]/g) || []).length / t.length;
    };
    // 똑바로 든 사진(글줄이 가로)은 그대로 읽고, 옆으로 누운 사진만 양쪽 방향을 시험합니다.
    const upright = Math.abs(G[0]) >= Math.abs(G[1]);
    const testIdx = upright ? [] : geos.map((g, i) => i).filter(i => geos[i].long).sort((a, b) => geos[b].w - geos[a].w).slice(0, 8);
    let diff = 0;
    for (const i of testIdx) {
      const r0 = await readText(img, geos[i]), r1 = await readText(img, flip(geos[i]));
      cache.set(i, r0); diff += r0.score * latin(r0) - r1.score * latin(r1);
      if (Math.abs(diff) > 1.5) break;
    }
    const flipAll = diff < 0;
    if (flipAll) cache.clear();
    const minScore = opts.textScore == null ? 0.5 : opts.textScore;
    const lines = [];
    for (let i = 0; i < geos.length; i++) {
      const g = flipAll ? flip(geos[i]) : geos[i];
      const r = cache.get(i) || await readText(img, g);
      if (r.text.trim() && r.score >= minScore) lines.push({ text: r.text.trim(), score: r.score, g });
    }
    if (opts.debug) Object.assign(opts.debug, { detMs: t1 - t0, recMs: performance.now() - t1, boxes: boxes.length, tests: testIdx.length });
    return lines;
  }

  // 사진 속 평행사변형 영역만 잘라 다시 읽기(작은 사이즈 글자 S/M 등 보충용)
  async function recognizeRegion(canvas, O, A, B, outW, outH) {
    await init();
    const src = pixelsOf(canvas);
    const c = makeCanvas(outW, outH), ctx = c.getContext('2d');
    const id = ctx.createImageData(outW, outH), d = id.data;
    const tmp = new Float32Array(3 * outW * outH);
    sampleBGR(src, O, A, B, outW, outH, tmp, outW, [0, 0, 0], [1 / 255, 1 / 255, 1 / 255]);
    const plane = outW * outH;
    for (let i = 0; i < plane; i++) { d[i * 4] = tmp[2 * plane + i]; d[i * 4 + 1] = tmp[plane + i]; d[i * 4 + 2] = tmp[i]; d[i * 4 + 3] = 255; }
    ctx.putImageData(id, 0, 0);
    const img = pixelsOf(c);
    const found = [];
    const boxes = await detect(img, { detMax: 2000, detMin: 640, boxThresh: 0.3 });
    for (const b of boxes) {
      const r = await readText(img, cropGeometry(b, [1, 0]));
      if (r.text.trim()) found.push({ text: r.text.trim(), score: r.score });
    }
    // 위치 찾기에 안 걸리는 한 글자(M 등)를 위해 띠 모양으로 통째로 읽기
    for (const [a, h] of [[0, 1], [0.3, 0.4], [0.1, 0.4], [0.5, 0.4]]) {
      const r = await readText(img, { O: [0, outH * a], A: [outW, 0], B: [0, outH * h], w: outW, h: outH * h });
      if (r.text.trim()) found.push({ text: r.text.trim(), score: r.score });
    }
    return found;
  }

  return { init, download, isDownloaded, remove, recognize, recognizeRegion, isReady: () => !!rec, TOTAL, canStore: 'caches' in self };
})();
