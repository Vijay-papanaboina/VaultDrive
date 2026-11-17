/* Only the public Downloads shell and immutable Next assets go in Cache Storage. */
const CACHE = "vaultdrive-downloads-shell-v1";
const DOCUMENT = "/downloads";
let preparing;

const isAsset = (url) => url.origin === self.location.origin && url.pathname.startsWith("/_next/static/");

async function prepare() {
  const cache = await caches.open(CACHE);
  try {
    const page = await fetch(DOCUMENT, { cache: "reload", credentials: "omit" });
    if (!page.ok || page.redirected || !page.headers.get("Content-Type")?.includes("text/html")) {
      throw new Error("Downloads page is not available.");
    }
    const old = await cache.match(DOCUMENT);
    const html = await page.clone().text();
    const assets = new Set(Array.from(html.matchAll(/\b(?:src|href)="([^"]+)"/g), ([, path]) => {
      return new URL(path.replaceAll("&amp;", "&"), self.location.origin);
    }).filter(isAsset).map((url) => url.href));
    if (!Array.from(assets).some((href) => new URL(href).pathname.endsWith(".js"))) {
      throw new Error("No Downloads application scripts were found.");
    }
    await Promise.all(Array.from(assets, async (url) => {
      if (await cache.match(url)) return;
      const asset = await fetch(url, { credentials: "omit", cache: "reload" });
      if (!asset.ok || asset.redirected) throw new Error("A Downloads asset is missing.");
      await cache.put(url, asset);
    }));
    await cache.put(DOCUMENT, page);
    // Keep the assets for the previous deployment too, for tabs open during an upgrade.
    if (old) {
      const previous = await old.text();
      for (const [, path] of previous.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
        const url = new URL(path.replaceAll("&amp;", "&"), self.location.origin);
        if (isAsset(url)) assets.add(url.href);
      }
    }
    const entries = await cache.keys();
    for (const request of entries) {
      const url = new URL(request.url);
      if (isAsset(url) && !assets.has(url.href)) await cache.delete(request);
    }
    return true;
  } catch {
    return Boolean(await cache.match(DOCUMENT));
  }
}

self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("message", (event) => {
  if (event.data !== "prepare-downloads" || !event.ports[0]) return;
  preparing ??= prepare().finally(() => { preparing = undefined; });
  event.waitUntil(preparing.then((ready) => event.ports[0].postMessage(ready), () => event.ports[0].postMessage(false)));
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate" && url.pathname === DOCUMENT) {
    event.respondWith(fetch(request).catch(async () => {
      return (await (await caches.open(CACHE)).match(DOCUMENT)) ?? Response.error();
    }));
  } else if (isAsset(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      const result = await fetch(request);
      if (result.ok && !result.redirected) await cache.put(request, result.clone()).catch(() => undefined);
      return result;
    })());
  }
});
