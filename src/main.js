// Entry point: open storage, load identity + settings, mount the UI.
import { iceServersFrom, loadSettings } from './config.js';
import { loadIdentity } from './crypto/identity.js';
import { IdbKV } from './store/kv.js';
import { rankStun } from './net/ice-probe.js';
import { AppModel } from './app.js';
import { mountUi } from './ui/view.js';

async function boot() {
  const root = document.getElementById('app');
  const kv = new IdbKV();
  const settings = await loadSettings(kv);
  const identity = await loadIdentity(kv);

  let rankedStun = null; // filled in the background; new links then use the fastest servers
  const model = new AppModel(
    { kv, identity, settings, iceServers: () => iceServersFrom(settings, rankedStun) },
  );
  await model.load();
  const ui = mountUi(root, model);

  // Deep links: #r=<room secret> joins a room, #c=<pairing code> opens the join dialog.
  const hash = location.hash.slice(1);
  if (hash) {
    history.replaceState(null, '', location.pathname + location.search);
    ui.openJoin(hash.startsWith('c=') ? hash.slice(2) : `#${hash}`);
  }

  rankStun(settings.stunServers).then((r) => { if (r.length) rankedStun = r.map((x) => x.url); });
  if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register(
    'sw.js',
  ).catch(() => {});
}

boot().catch((err) => {
  console.error(err);
  document.getElementById('app').textContent = `Could not start: ${err.message}`;
});
