// When the page comes back from the background, or the network does, the sockets and links that
// died meanwhile do not say so for a long time (a phone suspends them without a sound). `onWake`
// is called then, so they are replaced at once instead of after a timeout.

/** Calls `onWake()` when the page was hidden for `minHiddenMs` or more and shows again, when
 *  the browser comes back online, and when a page restored from the cache or resumed after a
 *  freeze is shown. Returns the function that stops listening. `win` is the window (tests). */
export function watchWake(onWake, { win = globalThis, minHiddenMs = 10_000, now = Date.now } = {}) {
  let hiddenAt = null;
  const visibility = () => {
    if (win.document?.visibilityState === 'hidden') { hiddenAt ??= now(); return; }
    const away = hiddenAt === null ? 0 : now() - hiddenAt;
    hiddenAt = null;
    if (away >= minHiddenMs) onWake();
  };
  const shown = (event) => { if (event?.persisted) onWake(); };
  win.document?.addEventListener?.('visibilitychange', visibility);
  win.document?.addEventListener?.('resume', onWake);
  win.addEventListener?.('online', onWake);
  win.addEventListener?.('pageshow', shown);
  return () => {
    win.document?.removeEventListener?.('visibilitychange', visibility);
    win.document?.removeEventListener?.('resume', onWake);
    win.removeEventListener?.('online', onWake);
    win.removeEventListener?.('pageshow', shown);
  };
}
