// ============================================================================
// native-migration.js  ·  MIGRATION VERSION: v1
// The Ledger — one-time copy of existing localStorage data into native storage
// the first time the wrapped (Capacitor) app runs.
// ----------------------------------------------------------------------------
// WHY THIS EXISTS
// When the app first launches as a native app, Capacitor's native storage is
// EMPTY. If the tester (or you) had data in the old PWA's localStorage on the
// same device, that data does not automatically appear in native storage —
// they'd open the native app to a blank slate. This script copies it across
// ONCE, then marks itself done so it never runs again.
//
// ⚠ THIS IS THE ORPHANING MOMENT. Swapping storage systems is exactly where
// data goes missing. Two safeguards:
//   1. The runbook has you EXPORT A BACKUP before installing the native app,
//      so a file always exists to import if anything goes wrong.
//   2. This script is COPY-ONLY. It never deletes the localStorage source.
//      If the copy misbehaves, the original is untouched.
//
// ----------------------------------------------------------------------------
// HOW IT RUNS
// Loaded in index.html AFTER storage-shim.js and BEFORE the app bundle, so
// window.storage already exists (in native mode) when this runs. It is a no-op
// in the browser/PWA (no Capacitor → nothing to migrate to).
//
// The keys copied match what the app actually uses:
//   budget-data, budget-transactions, backup-snooze-until, budget-collapsed-cats
// If the app gains new storage keys later, add them to KEYS below.
// ----------------------------------------------------------------------------

(async function () {
  // Only run inside the native app. In the browser there's nothing to migrate.
  const cap = window.Capacitor;
  const isNative =
    !!cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform();
  if (!isNative) return;

  // localStorage may not exist / may be empty in the native webview — that's fine.
  let ls;
  try { ls = window.localStorage; } catch (_) { ls = null; }
  if (!ls) return;

  const DONE_FLAG = "native-migration-done-v1";

  // Already migrated? Never run again.
  try {
    const done = await window.storage.get(DONE_FLAG);
    if (done && done.value === "true") return;
  } catch (_) {
    // get() throws when the flag is absent → migration hasn't run yet. Continue.
  }

  // The keys the app stores. Add to this list if new keys are introduced.
  const KEYS = [
    "budget-data",
    "budget-transactions",
    "backup-snooze-until",
    "budget-collapsed-cats",
  ];

  let copied = 0;
  for (const key of KEYS) {
    let val = null;
    try { val = ls.getItem(key); } catch (_) { val = null; }
    if (val === null || val === undefined) continue; // nothing in localStorage for this key

    // Only copy if native storage doesn't already have it — never clobber
    // data the native app has already written.
    let alreadyThere = false;
    try {
      const existing = await window.storage.get(key);
      alreadyThere = existing && existing.value !== null && existing.value !== undefined;
    } catch (_) {
      alreadyThere = false; // get() threw → key absent in native → safe to copy
    }
    if (alreadyThere) continue;

    try {
      await window.storage.set(key, val, false); // COPY (source is left intact)
      copied++;
    } catch (_) {
      // If one key fails, keep going — a partial copy is better than aborting,
      // and the exported backup is the ultimate safety net.
    }
  }

  // Mark done so this never runs a second time (even if 0 keys were copied —
  // 0 means there was nothing to migrate, which is itself "done").
  try {
    await window.storage.set(DONE_FLAG, "true", false);
  } catch (_) {}

  try { console.log(`[native-migration v1] copied ${copied} key(s) from localStorage`); } catch (_) {}
})();
