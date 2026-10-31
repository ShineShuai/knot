// Entry point: open storage, load identity + settings, mount the UI.
import { iceServersFrom, loadSettings } from './config.js';
import { applyDelegation } from './crypto/delegation.js';
import { loadIdentity } from './crypto/identity.js';
import { IdbKV } from './store/kv.js';
import { rankStun } from './net/ice-probe.js';
import { BrokerHealth } from './net/broker-health.js';
import { holdInstance } from './store/instance-lock.js';
import { keepStorage } from './store/persist.js';
import { watchErrors } from './ui/diagnostics.js';
import { AppModel } from './app.js';
import { UpdateWatcher } from './update.js';
import { h } from './ui/dom.js';
import { setLanguage, t } from './ui/i18n.js';
import { mountUi } from './ui/view.js';

async function boot() {
  watchErrors();
  const root = document.getElementById('app');
  const kv = new IdbKV();
  const settings = await loadSettings(kv);
  setLanguage(settings.language);
  // Before the identity is read: a first run in two tabs would make two identities.
  if (!(await holdInstance())) {
    root.replaceChildren(h('main', { class: 'instance-open' }, h('h1', {}, t('instanceTitle')),
      h('p', {}, t('instanceText')),
      h('button', { class: 'primary', onclick: () => location.reload() }, t('instanceRetry'))));
    return;
  }
  const identity = await applyDelegation(await loadIdentity(kv), kv);

  const brokerHealth = new BrokerHealth();
  let rankedStun = null; // filled in the background; new links then use the fastest servers
  const model = new AppModel(
    {
      kv, identity, settings, iceServers: () => iceServersFrom(settings, rankedStun),
      brokerHealth,
    },
  );
  await model.load();
  const updates = new UpdateWatcher({
    running: document.querySelector('meta[name="build"]')?.content,
  });
  const ui = mountUi(root, model, { updates });
  updates.start();

  // Deep links: #r=<room secret> joins a room, #c=<pairing code> opens the join dialog.
  const hash = location.hash.slice(1);
  if (hash) {
    history.replaceState(null, '', location.pathname + location.search);
    ui.openJoin(hash.startsWith('c=') ? hash.slice(2) : `#${hash}`);
  }

  brokerHealth.start(() => (settings.brokersEnabled ? settings.brokers : []));
  // Ask the browser to keep our data; it decides by its own rules, and some want a click.
  window.addEventListener('pointerdown', () => keepStorage(), { once: true });
  rankStun(settings.stunServers).then((r) => { if (r.length) rankedStun = r.map((x) => x.url); });
  if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register(
    'sw.js',
  ).catch(() => {});
}

boot().catch((err) => {
  console.error(err);
  document.getElementById('app').textContent = `Could not start: ${err.message}`;
});
