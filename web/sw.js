// SINOON 웹 버전 오프라인용: 한 번 열어둔 화면·상품 데이터·엑셀 도구를 휴대폰에 보관해서
// 인터넷이 없어도 열리게 합니다. 상품 데이터는 인터넷이 되면 항상 최신 것으로 받아옵니다.
const CACHE = 'sinoon-web-v2';
const DATA = '../assets/product_barcodes.json';
const SHELL = ['./', './index.html', './manifest.json', './icon.svg', DATA,
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isPage = req.mode === 'navigate' || url.pathname.endsWith('.json') || url.pathname.endsWith('.html');
  if (isPage) {
    // 화면·데이터: 인터넷이 되면 최신 것, 안 되면 보관해둔 것
    e.respondWith(fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('./index.html'))));
  } else {
    // 아이콘·엑셀 도구: 보관해둔 것을 먼저
    e.respondWith(caches.match(req).then((r) => r || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    })));
  }
});
