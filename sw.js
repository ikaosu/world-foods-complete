/* 世界料理制覇マップ — Service Worker
 * ネットワーク優先 + キャッシュフォールバック。
 * 常に最新を取りに行き（?v= やデータ更新を反映）、オフライン時のみキャッシュを返す。
 */
const CACHE = "wfm-v1";
const SHELL = [
  "./",
  "./index.html",
  "./assets/styles.css",
  "./assets/app.js",
  "./assets/post.js",
  "./data/countries.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // GitHub API や外部への書き込み/取得は SW を通さない
  if (url.hostname === "api.github.com") return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        // 同一オリジンの正常応答だけランタイムキャッシュ
        if (res && res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match("./index.html")))
  );
});
