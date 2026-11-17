import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "https://vaultdrive.test";
const DOCUMENT = "/downloads";
const CACHE_NAME = "vaultdrive-downloads-shell-v1";
const SERVICE_WORKER_PATH = path.join(ROOT, "public", "offline-downloads.js");

function assetUrls(html) {
  return new Set(Array.from(html.matchAll(/\b(?:src|href)="([^"]+)"/g), ([, reference]) => {
    return new URL(reference.replaceAll("&amp;", "&"), ORIGIN);
  }).filter((url) => url.origin === ORIGIN && url.pathname.startsWith("/_next/static/")).map((url) => url.href));
}

function syntheticFixture() {
  const html = `<!doctype html><html><head><link rel="stylesheet" href="/_next/static/css/downloads.css"></head><body><main>Downloads</main><a href="/api/drive/meta/private">API</a><a href="/signin">Sign in</a><script src="/api/auth/session"></script><script src="/_next/static/chunks/downloads.js"></script></body></html>`;
  return {
    html,
    assets: new Map([
      ["/_next/static/css/downloads.css", Buffer.from("body { color: white; }")],
      ["/_next/static/chunks/downloads.js", Buffer.from("window.downloadsShell = true;")],
    ]),
    source: "synthetic",
  };
}

async function builtFixture() {
  const htmlPath = path.join(ROOT, ".next", "server", "app", "downloads.html");
  const staticRoot = path.join(ROOT, ".next", "static");
  try {
    const html = await readFile(htmlPath, "utf8");
    const urls = assetUrls(html);
    if (![...urls].some((href) => new URL(href).pathname.endsWith(".js"))) return null;
    const assets = new Map();
    for (const href of urls) {
      const url = new URL(href);
      const relative = decodeURIComponent(url.pathname.slice("/_next/static/".length));
      const filename = path.resolve(staticRoot, relative);
      if (!filename.startsWith(`${staticRoot}${path.sep}`)) return null;
      assets.set(url.pathname, await readFile(filename));
    }
    return { html, assets, source: "built" };
  } catch {
    return null;
  }
}

const fixture = await builtFixture() ?? syntheticFixture();
const serviceWorkerSource = await readFile(SERVICE_WORKER_PATH, "utf8");

function cacheKey(request) {
  const value = typeof request === "string" ? request : request.url;
  return new URL(value, ORIGIN).href;
}

class MemoryCache {
  constructor() {
    this.responses = new Map();
  }

  async match(request) {
    const response = this.responses.get(cacheKey(request));
    return response?.clone();
  }

  async put(request, response) {
    this.responses.set(cacheKey(request), response.clone());
  }

  async keys() {
    return [...this.responses.keys()].map((url) => ({ url }));
  }

  async delete(request) {
    return this.responses.delete(cacheKey(request));
  }
}

function createHarness() {
  const listeners = new Map();
  const cache = new MemoryCache();
  const requested = [];
  const failedPaths = new Set();
  const calls = { skipWaiting: 0, claim: 0 };
  let currentHtml = fixture.html;
  let offline = false;

  const self = {
    location: { origin: ORIGIN },
    clients: { claim: async () => { calls.claim += 1; } },
    skipWaiting: async () => { calls.skipWaiting += 1; },
    addEventListener(type, listener) { listeners.set(type, listener); },
  };
  const caches = { open: async (name) => {
    assert.equal(name, CACHE_NAME);
    return cache;
  } };
  const fetch = async (input, options = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, ORIGIN);
    requested.push({ url: url.href, path: url.pathname, credentials: options.credentials });
    if (offline) throw new Error("network unavailable");
    if (url.pathname === DOCUMENT) {
      return new Response(currentHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    if (failedPaths.has(url.pathname)) return new Response("asset unavailable", { status: 503 });
    const body = fixture.assets.get(url.pathname);
    if (body) return new Response(body, { headers: { "Content-Type": url.pathname.endsWith(".js") ? "text/javascript" : "text/css" } });
    return new Response("not found", { status: 404 });
  };

  vm.runInNewContext(serviceWorkerSource, { self, caches, fetch, URL, Response }, { filename: SERVICE_WORKER_PATH });

  const dispatchInstall = async (type) => {
    const waits = [];
    listeners.get(type)({ waitUntil(promise) { waits.push(promise); } });
    await Promise.all(waits);
  };
  const dispatchMessage = async (data = "prepare-downloads") => {
    const waits = [];
    const replies = [];
    listeners.get("message")({
      data,
      ports: [{ postMessage(value) { replies.push(value); } }],
      waitUntil(promise) { waits.push(promise); },
    });
    await Promise.all(waits);
    return replies;
  };
  const dispatchFetch = async (request) => {
    let response;
    listeners.get("fetch")({ request, respondWith(value) { response = value; } });
    return response === undefined ? undefined : await response;
  };

  return {
    cache,
    calls,
    requested,
    failedPaths,
    setHtml(html) { currentHtml = html; },
    setOffline(value) { offline = value; },
    dispatchInstall,
    dispatchMessage,
    dispatchFetch,
  };
}

async function cachedPaths(cache) {
  return (await cache.keys()).map(({ url }) => new URL(url).pathname).sort();
}

async function warm(harness) {
  const replies = await harness.dispatchMessage();
  assert.deepEqual(replies, [true], `prepare-downloads should succeed with the ${fixture.source} fixture`);
  return replies;
}

test(`install, activate, and warm-up keep only the public Downloads shell and static assets (${fixture.source} fixture)`, async () => {
  const harness = createHarness();
  await harness.dispatchInstall("install");
  await harness.dispatchInstall("activate");
  assert.equal(harness.calls.skipWaiting, 1);
  assert.equal(harness.calls.claim, 1);

  await warm(harness);
  const urls = await harness.cache.keys();
  const paths = urls.map(({ url }) => new URL(url).pathname).sort();
  const expectedAssets = [...assetUrls(fixture.html)].map((href) => new URL(href).pathname).sort();
  assert.deepEqual(paths, [DOCUMENT, ...expectedAssets].sort());
  assert.ok(paths.includes(DOCUMENT));
  assert.ok(expectedAssets.some((asset) => asset.endsWith(".js")));
  assert.ok(paths.every((item) => item === DOCUMENT || item.startsWith("/_next/static/")));
  assert.ok(harness.requested.length >= expectedAssets.length + 1);
  assert.ok(harness.requested.every(({ path }) => path === DOCUMENT || path.startsWith("/_next/static/")));
  assert.ok(harness.requested.every(({ credentials }) => credentials === "omit"));

  harness.setOffline(true);
  const apiResponse = await harness.dispatchFetch({ method: "GET", mode: "cors", url: `${ORIGIN}/api/drive/meta/private` });
  assert.equal(apiResponse, undefined, "API routes should not be handled by the shell worker");
});

test(`offline navigation and static JavaScript reload from the complete cache (${fixture.source} fixture)`, async () => {
  const harness = createHarness();
  await warm(harness);
  const beforeOfflineRequests = harness.requested.length;
  harness.setOffline(true);

  const navigation = await harness.dispatchFetch({ method: "GET", mode: "navigate", url: `${ORIGIN}${DOCUMENT}` });
  assert.equal(navigation.status, 200);
  assert.equal(await navigation.text(), fixture.html);

  const scriptUrl = [...assetUrls(fixture.html)].find((href) => new URL(href).pathname.endsWith(".js"));
  assert.ok(scriptUrl, "fixture must include a Downloads script");
  const script = await harness.dispatchFetch({ method: "GET", mode: "same-origin", url: scriptUrl });
  assert.equal(script.status, 200);
  assert.deepEqual(Buffer.from(await script.arrayBuffer()), fixture.assets.get(new URL(scriptUrl).pathname));
  assert.equal(harness.requested.length, beforeOfflineRequests + 1, "the cached script should not trigger another network request");
});

test(`a failed refresh preserves the previously complete shell snapshot (${fixture.source} fixture)`, async () => {
  const harness = createHarness();
  await warm(harness);
  const priorPaths = await cachedPaths(harness.cache);
  const newAsset = "/_next/static/chunks/downloads-refresh.js";
  harness.setHtml(`<!doctype html><html><body><main>New Downloads shell</main><script src="${newAsset}"></script></body></html>`);
  harness.failedPaths.add(newAsset);

  const replies = await harness.dispatchMessage();
  assert.deepEqual(replies, [true], "an old complete shell keeps the worker prepared after refresh fails");
  assert.deepEqual(await cachedPaths(harness.cache), priorPaths);
  const oldPage = await harness.cache.match(DOCUMENT);
  assert.ok(oldPage);
  assert.equal(await oldPage.text(), fixture.html);
  assert.equal(await harness.cache.match(newAsset), undefined);
});
