// Replaces Claude's window.storage (which only exists inside Claude.ai
// artifacts) with a plain localStorage-backed implementation carrying the
// exact same interface, so the app's persist()/load code needs no changes.
// Matches the real API's documented behavior: get() on a missing key
// throws rather than returning null.
window.storage = {
  async get(key) {
    const value = localStorage.getItem(key);
    if (value === null) throw new Error(`Key not found: ${key}`);
    return { key, value };
  },
  async set(key, value /*, shared - ignored, no concept of "shared" outside Claude.ai */) {
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
