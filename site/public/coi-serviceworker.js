/*
 * Cross-origin isolation for a host that cannot set headers.
 *
 * ONNX only uses more than one core when the page is cross-origin isolated,
 * which normally needs COOP/COEP response headers. GitHub Pages serves plain
 * static files and sends no such headers, so the voice runs single-threaded
 * and speech comes out slower than real time.
 *
 * A service worker sits in front of the page's own requests and adds the
 * headers on the way through. Same trick the wasm community uses.
 *
 * This one file is both the worker and the script that installs it: loaded by
 * the page it registers itself, loaded as a worker it takes the other branch.
 * Browsers that do not support it (Safari, today) simply stay un-isolated and
 * fall back to one core, which is where they already were.
 */
if (typeof window === "undefined") {
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

  self.addEventListener("fetch", event => {
    const req = event.request;
    if (req.cache === "only-if-cached" && req.mode !== "same-origin") return;

    event.respondWith(fetch(req).then(res => {
      if (res.status === 0) return res;           // opaque; nothing to rewrite
      const headers = new Headers(res.headers);
      headers.set("Cross-Origin-Embedder-Policy", "credentialless");
      headers.set("Cross-Origin-Opener-Policy", "same-origin");
      return new Response(res.body, {
        status: res.status, statusText: res.statusText, headers,
      });
    }).catch(err => {
      console.error("coi:", err);
      throw err;
    }));
  });
} else {
  (async () => {
    if (window.crossOriginIsolated) return;
    if (!window.isSecureContext || !navigator.serviceWorker) return;

    const src = document.currentScript?.src;
    if (!src) return;
    try {
      const reg = await navigator.serviceWorker.register(src);
      reg.addEventListener("updatefound", () => window.location.reload());
      if (reg.active && !navigator.serviceWorker.controller) window.location.reload();
    } catch (err) {
      console.error("coi: could not register", err);
    }
  })();
}
