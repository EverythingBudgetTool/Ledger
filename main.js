import React from "react";
import { createRoot } from "react-dom/client";
import FamilyBudgetApp from "./app.js";

const root = createRoot(document.getElementById("root"));
root.render(React.createElement(FamilyBudgetApp));

// Register the service worker for offline support once the app has mounted.
//
// ⚠ NOT UNDER CAPACITOR. Found Aug 9 on the first real native run: the app
// booted to a permanent loading screen, and the console showed "WebView loaded"
// TWICE — the page was reloading itself in a loop and never rendered.
//
// Cause: service-worker.js calls skipWaiting() on install and clients.claim()
// on activate. That pairing is deliberate and correct on the WEB — it's how a
// new build takes over a tab immediately instead of waiting for every tab to
// close. Inside a Capacitor webview served from capacitor://localhost it means
// the worker installs, claims the page, and the claim can restart the page —
// which installs again. A loop with no error, which is why nothing showed up
// in the JS console.
//
// ⚠ It also has NO PURPOSE natively. The service worker exists to cache the app
// shell so the PWA works offline. In the native app every file is already on
// the device — there is nothing to cache and nothing to be offline from.
//
// The web build is completely unaffected: window.Capacitor is undefined in a
// browser, so registration happens exactly as before.
const isNativeApp = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === "function"
                       && window.Capacitor.isNativePlatform());
if (!isNativeApp && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(err => {
      console.warn("Service worker registration failed:", err);
    });
  });
}

// ⚠ NATIVE: ACTIVELY UNREGISTER ANY SERVICE WORKER LEFT BEHIND.
//
// Build 110 added the guard above so a service worker is never REGISTERED
// under Capacitor. That was necessary but not sufficient: the native app had
// already run earlier builds WITHOUT the guard, and those registrations
// PERSIST in the webview's storage. A guard that only prevents new
// registrations leaves the old one installed, still claiming the page and
// still able to restart it — the reload loop returns intermittently, long
// after the code that caused it is gone.
//
// Her report, build 110: the native app hung again, and clearing browser data
// fixed it. That is the signature of stale STORED state rather than bad code.
//
// So: on native, don't just abstain — clean up. Unregister everything and drop
// the caches. Idempotent; a no-op once there is nothing left to remove.
if (isNativeApp && "serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations()
    .then(regs => {
      if (!regs.length) return;
      console.log("[native] removing " + regs.length + " stale service worker registration(s)");
      return Promise.all(regs.map(r => r.unregister()));
    })
    .then(() => (typeof caches !== "undefined" && caches.keys ? caches.keys() : []))
    .then(keys => Promise.all((keys || []).map(k => caches.delete(k))))
    .catch(err => console.warn("[native] service worker cleanup failed:", err));
}
