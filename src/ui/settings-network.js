// The network page of the settings: brokers, relay, STUN and TURN. A wrong list can cut a person
// off from every room, so the lists are checked while they are typed and applied together, with
// the Apply bar, not one by one.
import { networkDefaults, networkProblems } from '../config.js';
import { h } from './dom.js';
import { t } from './i18n.js';
import { applyBar, field, switchRow } from './settings-shell.js';

const lines = (el) => el.value.split('\n').map((l) => l.trim()).filter(Boolean);
const addresses = (text) => text.split(/[\s,]+/).filter(Boolean);

export class NetworkPage {
  constructor(ui) { this.ui = ui; }

  /** TURN servers as rows of address, user name and password. Whatever else a server has
   *  is kept as it was. */
  #turnRows(servers, changed) {
    const node = h('div', { class: 'turn-rows' });
    let rows = [];
    const add = (server = {}) => {
      const box = (placeholder, value) => h('input', {
        type: 'text', value, placeholder, 'aria-label': placeholder,
      });
      const row = {
        server,
        url: box(t('turnUrl'), [server.urls ?? []].flat().join(' ')),
        user: box(t('turnUser'), server.username ?? ''),
        pass: box(t('turnPass'), server.credential ?? ''),
      };
      row.node = h('div', { class: 'turn' }, row.url, row.user, row.pass, h('button', {
        class: 'ghost', title: t('turnRemove'), 'aria-label': t('turnRemove'),
        onclick: () => { rows = rows.filter((r) => r !== row); row.node.remove(); changed(); },
      }, '×'));
      for (const input of [row.url, row.user, row.pass]) input.addEventListener('input', changed);
      rows.push(row);
      node.append(row.node);
    };
    const fill = (list) => { rows = []; node.replaceChildren(); list.forEach((s) => add(s)); };
    fill(servers);
    const read = () => rows.map(({ server, url, user, pass }) => ({
      ...server,
      urls: addresses(url.value),
      username: user.value.trim(),
      credential: pass.value.trim(),
    })).filter((s) => s.urls.length)
      .map((s) => ({ ...s, urls: s.urls.length > 1 ? s.urls : s.urls[0] }));
    return { node, fill, read, add: () => { add(); changed(); } };
  }

  render({ refresh }) {
    const { model } = this.ui;
    const s = model.settings;
    const useBrokers = h('input', { type: 'checkbox', role: 'switch', checked: s.brokersEnabled });
    const relay = h('input', { type: 'checkbox', role: 'switch', checked: s.relayFallback });
    const brokers = h('textarea', { class: 'code', rows: 3, value: s.brokers.join('\n') });
    const stun = h('textarea', { class: 'code', rows: 3, value: s.stunServers.join('\n') });
    const problem = () => h('p', { class: 'err', hidden: true, role: 'alert' });
    const errors = { brokers: problem(), stun: problem(), turn: problem() };
    const inputs = { brokers, stun };
    const advanced = h('details', {});
    let turn = null; // set below: it calls `check` when a row is removed

    const read = () => ({
      brokersEnabled: useBrokers.checked,
      brokers: lines(brokers),
      relayFallback: relay.checked,
      stunServers: lines(stun),
      turnServers: turn.read(),
    });
    const check = () => {
      const found = networkProblems(read());
      for (const [name, el] of Object.entries(errors)) {
        const one = found.find((f) => f.field === name);
        el.hidden = !one;
        el.textContent = one ? t(one.code, one) : '';
        inputs[name]?.setAttribute('aria-invalid', Boolean(one));
      }
      bar.apply.disabled = found.length > 0;
      return found;
    };
    const edited = () => { bar.show(); check(); }; // any change: Apply appears, lists are checked
    const bar = applyBar(async () => {
      const found = check();
      if (found.some((f) => f.field !== 'brokers')) advanced.open = true; // show what is wrong
      if (found.length) return;
      try {
        await model.updateSettings(read());
        this.ui.notify(t('saved'));
        bar.hide();
      } catch (err) { this.ui.notify(t('badSettings', { why: err.message })); }
    }, refresh);
    turn = this.#turnRows(s.turnServers, edited);

    // What the brokers do right now: probed at start and on request.
    const health = model.brokerHealth;
    const rows = h('ul', { class: 'broker-health' });
    const showBrokers = () => rows.replaceChildren(...(health?.rows(lines(brokers)) ?? []).map(
      (r) => h('li', { class: r.ok ? 'up' : r.ok === false ? 'down' : '' },
        `${r.ok ? '✓' : r.ok === false ? '✗' : '…'} `
        + t(r.ok ? 'brokerUp' : r.relay === false ? 'brokerNoRelay'
          : r.ok === false ? 'brokerDown' : 'brokerUnknown', r)),
    ));
    const checkBrokers = h('button', { onclick: async () => {
      await health.check(lines(brokers));
      showBrokers();
    } }, t('brokerCheck'));
    if (health) {
      showBrokers();
      this.ui.dialog.addEventListener('close', health.on('change', showBrokers), { once: true });
    }

    const reset = h('button', { onclick: () => {
      const d = networkDefaults();
      useBrokers.checked = d.brokersEnabled;
      relay.checked = d.relayFallback;
      brokers.value = d.brokers.join('\n');
      stun.value = d.stunServers.join('\n');
      turn.fill(d.turnServers);
      showBrokers();
      bar.show();
      check();
    } }, t('resetDefaults'));

    advanced.append(
      h('summary', {}, t('advancedNet')),
      field(t('stun'), stun), errors.stun,
      h('div', { class: 'field' }, h('span', {}, t('turn')), turn.node, errors.turn,
        h('button', { onclick: turn.add }, t('turnAdd'))),
    );
    const root = h('div', {},
      switchRow(t('useBrokers'), useBrokers),
      field(t('brokerList'), brokers), errors.brokers,
      health ? h('div', { class: 'field' }, rows, checkBrokers) : null,
      switchRow(t('relayText'), relay),
      advanced,
      h('div', { class: 'actions' }, reset,
        h('a', { class: 'button', href: 'lab/lab.html' }, t('lab'))),
      bar.node);
    for (const el of [brokers, stun]) el.addEventListener('input', edited);
    for (const el of [useBrokers, relay]) el.addEventListener('change', edited);
    check();
    return root;
  }
}
