// SINOON 웹 버전 오프라인용: 한 번 열어둔 화면·상품 데이터·엑셀 도구·글자 인식 도구를 휴대폰에 보관해서
// 인터넷이 없어도 열리게 합니다. 화면과 상품 데이터는 인터넷이 되면 항상 최신 것으로 받아옵니다.
const CACHE = 'sinoon-web-v4';
const OCR_CACHE = 'sinoon-ocr-v1'; // 글자 인식 모델(약 27MB)은 화면이 바뀌어도 다시 받지 않도록 따로 보관
const DATA = '../assets/product_barcodes.json';
const SHELL = ['./', './index.html', './ocr.js', './manifest.json', './icon.svg', DATA,
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'];
const isOcrFile = (url) => url.startsWith('https://cdn.jsdelivr.net/npm/onnxruntime-web@') ||
  url.startsWith('https://cdn.jsdelivr.net/npm/@gutenye/ocr-models@');

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== OCR_CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

function cacheFirst(req, cacheName) {
  return caches.open(cacheName).then((c) => c.match(req).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok || res.type === 'opaque') c.put(req, res.clone());
    return res;
  })));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    // 우리 화면·코드·데이터: 인터넷이 되면 최신 것, 안 되면 보관해둔 것
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()))));
  } else if (isOcrFile(req.url)) {
    // 글자 인식 모델·실행 도구(버전 고정): 한 번 받으면 계속 보관해둔 것을 씀
    e.respondWith(cacheFirst(req, OCR_CACHE));
  } else {
    // 엑셀 도구 등(버전 고정): 보관해둔 것을 먼저
    e.respondWith(cacheFirst(req, CACHE));
  }
});
