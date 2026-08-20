// ============================================================================
// storage-shim.js  ·  SHIM VERSION: v2 (Capacitor-ready, auto-detecting)
// The Ledger — prepared 2026-07-18 for the Capacitor migration.
// ----------------------------------------------------------------------------
// WHAT THIS IS
// The app never calls localStorage directly. It calls window.storage.get /
// set / delete / list, and this file is what those calls land on. This version
// AUTO-DETECTS its environment and picks a backend at load time:
//
//   • Running inside the Capacitor native app  → Capacitor Preferences
//     (UserDefaults on iOS). This is NATIVE storage: iOS's 7-day web-storage
//     eviction does not apply to it. This is the whole point of the migration.
//
//   • Running as a plain web page / current PWA → localStorage
//     (identical behavior to the previous shim, so nothing changes today).
//
// The five-method interface and its exact behavior are IDENTICAL in both
// modes, so FamilyBudgetApp.jsx needs no changes. Same file works before AND
// after wrapping — deploy it to the current PWA now; it just runs in
// localStorage mode until it's inside Capacitor.
//
// ----------------------------------------------------------------------------
// ⚠ THE ONE CONTRACT THAT MUST NOT DRIFT
// get(missingKey) MUST THROW. The app's load path and the auto-backup snooze
// read both rely on get() throwing (not returning null) when a key is absent —
// they catch the throw. Capacitor's Preferences.get returns {value:null} for a
// missing key, so this shim CONVERTS that null back into a throw. localStorage
// mode preserves the original throw directly. Do not "simplify" either path to
// return null; that silently breaks loading.
//
// ----------------------------------------------------------------------------
// ⚠ SHIM v2 (build 135) — THE THROW NOW CARRIES A REASON
//
// The throw is UNCHANGED and every existing caller keeps working: all fourteen
// call sites in the app do `try { get() } catch { treat as absent }`, and they
// still do. What is new is that a not-found throw carries `err.notFound = true`.
//
// WHY: build 133's load path needed to tell "this key isn't there" (a FRESH
// INSTALL — open a new empty app) apart from "storage is broken" (REFUSE to
// touch anything). v1 collapsed both into an identical throw, so it could not,
// and build 133 shipped showing an error screen to anyone with no data. The
// shim is the only code that actually knows which happened; everything above it
// is inferring. So the reason belongs here.
//
// ⚠ DO NOT express this as the error MESSAGE text. A message is prose a future
// edit rewords without thinking; `notFound` is a flag something would have to
// delete on purpose.
//
// ⚠ THIS FILE IS NOT IN THE BUILD ZIP'S FOLDER 1 — it lives in www/ and in the
// Ledger repo, and is updated by hand. So app.js and this file CAN drift. The
// app therefore does NOT trust the tag's presence: if a not-found throw arrives
// without `notFound` (i.e. an older shim), the load path falls back to calling
// list() and checking for the key itself. A stale shim is then merely slower,
// never wrong. Keep that fallback.
// ----------------------------------------------------------------------------

(function () {
  // Detect Capacitor + the Preferences plugin. Capacitor injects window.Capacitor;
  // isNativePlatform() is true only inside the wrapped iOS/Android app.
  const cap = window.Capacitor;
  const hasNative =
    !!cap &&
    typeof cap.isNativePlatform === "function" &&
    cap.isNativePlatform() &&
    cap.Plugins &&
    cap.Plugins.Preferences;

  const Preferences = hasNative ? cap.Plugins.Preferences : null;

  // Record the active backend so you can confirm which one is live at runtime
  // (see the console line at the bottom, and window.__STORAGE_BACKEND__).
  const BACKEND = hasNative ? "capacitor-preferences" : "localStorage";
  const SHIM_VERSION = 2;   // v2: not-found throws carry err.notFound

  // --- Capacitor Preferences backend ---------------------------------------
  const nativeStorage = {
    async get(key) {
      const { value } = await Preferences.get({ key });
      // Preserve the throw-on-missing contract the app depends on.
      // v2: the throw is tagged so a caller can tell absent from broken.
      if (value === null || value === undefined) {
        const err = new Error(`Key not found: ${key}`);
        err.notFound = true;
        throw err;
      }
      return { key, value };
    },
    async set(key, value /*, shared ignored */) {
      await Preferences.set({ key, value: String(value) });
      return { key, value };
    },
    async delete(key) {
      // Preferences.remove doesn't report whether the key existed, so check first
      // to keep the same {deleted:true} | null return shape as before.
      let existed = false;
      try {
        const res = await Preferences.get({ key });
        existed = res.value !== null && res.value !== undefined;
      } catch (_) {
        existed = false;
      }
      await Preferences.remove({ key });
      return existed ? { key, deleted: true } : null;
    },
    async list(prefix) {
      const { keys } = await Preferences.keys();
      const filtered = prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
      return { keys: filtered, prefix };
    },
  };

  // --- localStorage backend (unchanged behavior from the previous shim) -----
  const webStorage = {
    async get(key) {
      const value = localStorage.getItem(key);
      if (value === null) {
        const err = new Error(`Key not found: ${key}`);
        err.notFound = true;                      // v2 — see the header note
        throw err;
      }
      return { key, value };
    },
    async set(key, value /*, shared ignored */) {
      localStorage.setItem(key, value);
      return { key, value };
    },
    async delete(key) {
      const existed = localStorage.getItem(key) !== null;
      localStorage.removeItem(key);
      return existed ? { key, deleted: true } : null;
    },
    async list(prefix) {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!prefix || k.startsWith(prefix)) keys.push(k);
      }
      return { keys, prefix };
    },
  };

  window.storage = hasNative ? nativeStorage : webStorage;

  // Expose the active backend for quick confirmation (e.g. in Safari/Xcode
  // console: window.__STORAGE_BACKEND__ should read "capacitor-preferences"
  // once wrapped, "localStorage" in the browser).
  window.__STORAGE_BACKEND__ = BACKEND;
  window.__STORAGE_SHIM_VERSION__ = SHIM_VERSION;
  try { console.log("[storage-shim v" + SHIM_VERSION + "] backend:", BACKEND); } catch (_) {}
})();
