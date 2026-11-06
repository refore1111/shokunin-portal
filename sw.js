// 表示を速くする仕組み（GENPUKU Pro 協力業者ポータル）
// index.html と同じ場所に置いてください。
// ・ポータル本体（index.html など）：端末に保存した分をすぐ出し、裏で新しい版を取りに行く。新しい版があれば画面に「更新する」を出す
// ・Firebase の部品（gstatic.com/firebasejs/版番号/…）：版ごとに中身が変わらないので、一度取ったら端末の分を使う
// ・Firebase のデータ・ログイン・Stripe など、それ以外の通信には一切さわらない
const CACHE = "gp-shell-v1";
const SCOPE = new URL(self.registration.scope).pathname;   // 例：/shokunin-portal/

self.addEventListener("install", e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.add(new Request(SCOPE, {cache: "no-cache"}))).catch(() => {}));
});
self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// ページ（index.html・preview・manual など）の保存場所の名前：? や # を外し、…/index.html は …/ と同じにする
const pageKey = u => u.origin + u.pathname.replace(/index\.html$/, "");
const sameVersion = (a, b) => {
  const h = r => [r.headers.get("etag"), r.headers.get("last-modified"), r.headers.get("content-length")].join("|");
  return h(a) === h(b);
};

async function staleWhileRevalidate(e, key, isPage) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(key);
  const fresh = fetch(e.request.mode === "navigate" ? new Request(key, {cache: "no-cache", credentials: "same-origin"}) : new Request(e.request, {cache: "no-cache"}))
    .then(async res => {
      if (res && res.ok && res.type === "basic") {
        await cache.put(key, res.clone());
        if (cached && isPage && !sameVersion(cached, res)) {
          // 開いたばかりの画面に「新しい版があります」を届ける（画面ができるまで少し待つ）
          for (let i = 0; i < 20; i++) {
            const c = e.resultingClientId ? await self.clients.get(e.resultingClientId) : null;
            if (c) { c.postMessage({type: "gp-updated"}); break; }
            if (!e.resultingClientId) { (await self.clients.matchAll({type: "window"})).forEach(x => x.postMessage({type: "gp-updated"})); break; }
            await new Promise(r => setTimeout(r, 250));
          }
        }
      }
      return res;
    });
  if (cached) { e.waitUntil(fresh.catch(() => {})); return cached; }
  return fresh;
}

async function cacheFirst(e) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(e.request.url);
  if (hit) return hit;
  const res = await fetch(e.request);
  if (res && (res.ok || res.type === "opaque")) cache.put(e.request.url, res.clone()).catch(() => {});
  return res;
}

self.addEventListener("fetch", e => {
  const r = e.request;
  if (r.method !== "GET") return;
  const u = new URL(r.url);
  // Firebase の部品（版番号つき）
  if (u.hostname === "www.gstatic.com" && /^\/firebasejs\/\d+\.\d+\.\d+\//.test(u.pathname)) { e.respondWith(cacheFirst(e)); return; }
  if (u.origin !== self.location.origin || !u.pathname.startsWith(SCOPE)) return;
  if (u.pathname.endsWith("/sw.js") || u.pathname.endsWith("firebase-messaging-sw.js")) return;
  const isPage = r.mode === "navigate" || /\/$|\.html$/.test(u.pathname);
  if (isPage) { e.respondWith(staleWhileRevalidate(e, pageKey(u), true)); return; }
  // アイコン・manifest など
  if (/\.(png|webmanifest|ico|svg)$/.test(u.pathname)) { e.respondWith(staleWhileRevalidate(e, u.origin + u.pathname, false)); return; }
});
