// Ask the browser not to delete this app's storage (identity key, history, previews). Without
// it the browser may clear everything when space runs low (Safari: after about a week
// without a visit). The key cannot be recovered, so losing it means a new identity.
const storageOf = () => globalThis.navigator?.storage;

/** { supported, persisted } for the browser's storage right now. Never throws. */
export async function storageState(storage = storageOf()) {
  if (!storage?.persist) return { supported: false, persisted: false };
  try { return { supported: true, persisted: !!(await storage.persisted?.()) }; } catch {
    return { supported: true, persisted: false };
  }
}

/** Ask for persistent storage; resolves to whether we have it. Browsers decide by their own
 *  rules (a prompt, how often the site is used, being installed); a refusal is not an error. */
export async function keepStorage(storage = storageOf()) {
  if (!storage?.persist) return false;
  try { return (await storage.persisted?.()) || !!(await storage.persist()); } catch {
    return false;
  }
}
