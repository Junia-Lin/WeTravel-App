const CACHE_NAME = 'wetravel-v81';

// 一開啟就要存進離線快取的檔案：App 能完整運作所需要的「所有」靜態資源
// 之前漏掉 app.js／expense-data.js／firebase-config.js／icon 圖示／assets 圖片，
// 離線時只要缺一個，整個 App 就可能打不開或畫面缺東缺西。
const ASSETS = [
  './index.html',
  './manifest.json',
  './app.js',
  './checklist-data.js',
  './expense-data.js',
  './firebase-config.js',
  './icon-192.png',
  './icon-512.png',
  './vendor/tailwind-3.4.16.js',
  './vendor/vue-3.5.13.esm-browser.prod.js',
  './vendor/sortable-1.15.6.min.js',
  './vendor/phosphor/bold/style.css',
  './vendor/phosphor/bold/Phosphor-Bold.woff2',
  './vendor/phosphor/fill/style.css',
  './vendor/phosphor/fill/Phosphor-Fill.woff2',
  './vendor/phosphor/duotone/style.css',
  './vendor/phosphor/duotone/Phosphor-Duotone.woff2',
  './assets/BG_Loading.png',
  './assets/bow_pink.png',
  './assets/bow_red.png',
  './assets/icn_agent.png',
  './assets/icn_camera.png',
  './assets/icn_danial.png',
  './assets/icn_date.png',
  './assets/icn_head.png',
  './assets/icn_home.png',
  './assets/icn_kitty.png',
  './assets/icn_listen.png',
  './assets/icn_money.png',
  './assets/icn_pocket.png',
  './assets/icn_share.png',
  './assets/icn_speak.png',
  './assets/icn_trans.png',
  './assets/kitty1.png',
  './assets/kitty3.png',
  './assets/kitty_face_classic.png',
  './assets/kitty_face_pink.png',
  './assets/kitty_money.png',
  './assets/kitty_pilot.png',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&family=Noto+Sans+JP:wght@400;500;700;900&family=Noto+Sans+TC:wght@300;400;500;700&display=swap'
];

// 完全不快取的網址模式（即時 API／資料庫，離線時本來就該失敗，不該給舊資料）
const NO_CACHE_PATTERNS = [
  'firestore.googleapis.com',
  'www.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'nominatim.openstreetmap.org',
  'api.open-meteo.com',
  'api.exchangerate-api.com'
];

// Network First：連線時一律拿最新版並更新快取，離線時才退回快取版本
// 這裡用「結尾比對」而不是單純字串包含，避免像 firebase-app.js 這種檔名
// 被 app.js 的規則誤判（firebase-app.js 結尾雖然有 app.js 四個字，但不是同一支檔案）
const NETWORK_FIRST_SUFFIXES = [
  '/index.html',
  '/manifest.json',
  '/app.js',
  '/checklist-data.js',
  '/expense-data.js',
  '/firebase-config.js'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // 個別快取、個別失敗：單一檔案抓取失敗（例如暫時連不上字型 CDN）不會讓整批快取失敗，
      // 否則一失敗就等於這次完全沒存到任何離線快取
      Promise.all(
        ASSETS.map((url) =>
          cache.add(url).catch((err) => console.warn('[SW] 快取失敗，略過：', url, err))
        )
      )
    )
  );
});

self.addEventListener('activate', event => {
  // 清除舊版快取
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(
        names
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      )
    ).then(() => clients.claim())
      .then(() => {
        // 通知所有客戶端（頁面）新版本已啟用，觸發重載
        self.clients.matchAll({ type: 'window' }).then(clients => {
          clients.forEach(client => client.postMessage({ type: 'SW_UPDATED' }));
        });
      })
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 即時 API／資料庫：完全不碰快取，離線時就是該失敗（App 自己的連線狀態提示會處理）
  if (NO_CACHE_PATTERNS.some(pattern => req.url.includes(pattern))) {
    event.respondWith(fetch(req));
    return;
  }

  // 頁面本身（含 ?tripId=xxx 的網址）與核心程式檔：一律先連網拿最新版並更新快取，離線才用快取版本。
  // 比對時一定要忽略網址後面的 ?v=38、?tripId=…，否則會被當成一般靜態檔，永遠吃到舊快取，
  // 造成「檔案換了、畫面完全沒變」。
  const isNav = req.mode === 'navigate';
  const isCore = isNav || NETWORK_FIRST_SUFFIXES.some(suffix => url.pathname.endsWith(suffix));
  if (isCore) {
    const cacheKey = isNav ? new URL('./index.html', self.registration.scope).href : url.origin + url.pathname;
    event.respondWith(
      fetch(req)
        .then(response => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(cacheKey, clone));
          }
          return response;
        })
        .catch(() => caches.match(cacheKey).then(r => r || caches.match(req, { ignoreSearch: true })))
    );
    return;
  }

  // 其餘靜態資源（圖片、字體、第三方函式庫等）：快取優先，找不到才上網抓，抓到務必存回快取
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((response) => {
        if (response && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
        }
        return response;
      }).catch(() => cached);
    })
  );
});
