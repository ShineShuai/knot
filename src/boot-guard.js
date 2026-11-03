// A classic script that runs before the app. The app starts asynchronously (modules, storage,
// identity, rooms); if any step fails to finish, the page would show "Loading…" for ever with the
// reason only in the console. This says what it is waiting for, what went wrong and what to try.
// It is not an ES module on purpose: a module that fails to load must not take this down too.
(() => {
  const SLOW_MS = 10_000;
  const boot = { t0: Date.now(), stage: 'loading the files of the app', done: false, errors: [] };
  window.__knotBoot = boot;
  const secs = () => Math.round((Date.now() - boot.t0) / 1000);
  // what only a broken set of files causes (a missing icon is none of these)
  const MODULE_PROBLEM = new RegExp(
    'does not provide an export|dynamically imported|Unexpected token'
    + '|Importing a module script failed', 'i',
  );
  const FILE_PROBLEM = new RegExp(`${MODULE_PROBLEM.source}|could not load|Failed to fetch`, 'i');
  let panel = null;

  const note = (what, repairable = false) => {
    if (boot.errors.length < 8) boot.errors.push(`${secs()} s: ${what}`);
    if (repairable && !boot.done) setTimeout(autoRepair, 1500);
  };
  window.addEventListener('error', (e) => {
    const t = e.target;
    if (t && t !== window && (t.src || t.href)) {
      note(`could not load ${t.src || t.href}`, t.tagName === 'SCRIPT');
    } else note(String(e.message || 'error'), MODULE_PROBLEM.test(String(e.message)));
  }, true);
  window.addEventListener('unhandledrejection', (e) => {
    const what = String(e.reason?.message ?? e.reason);
    note(`rejected: ${what}`, MODULE_PROBLEM.test(what));
  });
  window.addEventListener('securitypolicyviolation', (e) => {
    note(`blocked by the security policy: ${e.blockedURI} (${e.violatedDirective})`);
  });

  /** What the app is doing now (called by main.js). */
  window.knotStage = (stage) => { boot.stage = stage; };
  /** The app is on screen. */
  window.knotBooted = () => { boot.done = true; };
  /** The app stopped with an error. */
  window.knotFail = (err) => show(`stopped: ${err?.message ?? err}`);

  const flag = (key, value) => {
    try {
      if (value === undefined) return sessionStorage.getItem(key);
      sessionStorage.setItem(key, value);
    } catch { /* storage blocked */ }
    return null;
  };

  /** Forget the saved copy of the app (not the rooms and messages) and load it again. */
  async function repair() {
    try {
      const workers = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
      for (const worker of workers) await worker.unregister();
    } catch { /* none */ }
    try {
      for (const key of await caches.keys()) await caches.delete(key);
    } catch { /* none */ }
    location.reload();
  }

  /** Once per visit, and only online (offline, the saved copy is all there is). */
  function autoRepair() {
    if (boot.done || !navigator.onLine || flag('knot-repaired')) return;
    flag('knot-repaired', '1');
    repair();
  }

  const STAGE_HINTS = [
    [/storage|settings/, 'The browser storage did not answer. Close other windows and tabs of '
      + 'this app, then restart the browser. Private browsing, a full disk or a blocked "site '
      + 'data" setting cause this too.'],
    [/tabs/, 'Another window or tab of this app may hold the database. Close it and reload.'],
    [/identity/, 'The keys are being read. Without WebCrypto support the app loads a library, '
      + 'which needs the network on the first visit.'],
    [/rooms/, 'A room is being opened. A very long history on a slow device takes a while; if '
      + 'it never moves, note the room named above and send the report.'],
  ];

  function hints() {
    const text = boot.errors.join('\n');
    const out = [];
    if (FILE_PROBLEM.test(text)) {
      out.push('A file of the app did not load, or its files come from two versions (an update '
        + 'that was cut off, or a very slow network). "Repair" clears the saved copy of the app '
        + 'and loads it again; rooms and messages are not touched.');
    }
    if (/security policy/.test(text)) {
      out.push('Something blocked the app (a browser extension or a strict network filter).');
    }
    for (const [re, hint] of STAGE_HINTS) if (re.test(boot.stage)) out.push(hint);
    if (!out.length) out.push('Reload once. If it stays, "Repair", and send the report.');
    return out;
  }

  function report() {
    const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content ?? '';
    const worker = navigator.serviceWorker?.controller ? 'active' : 'none';
    return [
      `knot boot report (${meta('channel')} ${meta('build').slice(0, 7)})`,
      navigator.userAgent,
      `online ${navigator.onLine}, service worker ${worker}`,
      `waiting for: ${boot.stage} (${secs()} s)`,
      ...boot.errors,
    ].join('\n');
  }

  function show(reason) {
    const app = document.getElementById('app');
    if (!app || boot.done) return;
    panel?.remove();
    const el = (tag, cls, text) => {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const button = (label, fn) => {
      const b = el('button', '', label);
      b.addEventListener('click', fn);
      return b;
    };
    const area = el('textarea', 'boot-report');
    area.readOnly = true;
    area.hidden = true;
    const showReport = () => {
      area.value = report();
      area.hidden = false;
      area.select();
      navigator.clipboard?.writeText(area.value).catch(() => {});
    };
    const actions = el('p', 'boot-actions');
    actions.append(
      button('Reload', () => location.reload()), button('Repair', repair),
      button('Show report', showReport),
    );
    panel = el('main', 'boot-fail');
    panel.append(
      el('h1', '', 'knot is not starting'),
      el('p', '', `It is ${reason}. Waiting for: ${boot.stage}.`),
      ...hints().map((hint) => el('p', '', hint)),
      ...(boot.errors.length ? [el('pre', '', boot.errors.join('\n'))] : []),
      actions, area,
    );
    app.replaceChildren(panel);
  }

  setTimeout(() => { if (!boot.done) show(`still starting after ${SLOW_MS / 1000} s`); }, SLOW_MS);
})();
