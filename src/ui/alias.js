// A name with the device it comes from, once a person uses several: "Ada @ phone".
import { t } from './i18n.js';

/** What stands between a name and its device: "Ada @ phone", a person at a device, as in
 *  user@host. The one place for it: messages, calls, exports and the bar all use it. */
export const AT = ' @ ';

/** `device`: null (one device: the plain name), '' (the main device) or a device's name. */
export const withDevice = (name, device) => (
  device === null || device === undefined ? name : `${name}${AT}${device || t('deviceMain')}`
);

/** Who a live connection (or this device, with our own id) is, for the bar and for calls. */
export const peerLabel = (room, id) => withDevice(room.nameOf(id), room.peerDevice(id));

const tag = (row) => (row.device ?? '') || t('deviceMain');
const STATE_KEY = { p2p: 'direct', offline: 'offlineState' };
/** The name of a connection type: direct, relay, seen, connecting, offline. */
export const stateName = (state) => t(STATE_KEY[state] ?? state);
const HELP_KEY = {
  p2p: 'helpDirect', relay: 'helpRelay', seen: 'helpSeen', connecting: 'helpConnecting',
  offline: 'helpOffline',
};
/** What a connection type means, in a sentence. */
export const stateHelp = (state) => t(HELP_KEY[state] ?? 'helpSeen');

/** The connection bar: one entry per person, however many of their devices are connected, and
 *  one for ourselves (`self`: Room.selfRow), shown as "You" whether we have linked devices or
 *  not. After the name, in brackets, how we are connected to them (for "You": the best way
 *  this device reaches the room); with several devices each is named after "@":
 *    Bob (direct)
 *    You (relay)
 *    Ada @ main (direct) | mac (relay)
 *    You @ main (this device, direct) | mac (direct) | pixel (relay)
 *  `rows`: Room.peerList. An entry is { name, mine, state (the best connection), text, parts
 *  ({ text, state } per device, each drawn in the colour of its connection), title (the
 *  digits to verify), help (what its connection types mean) }. */
export function peerEntries(rows, self = null) {
  const groups = new Map();
  for (const row of self ? [self, ...rows] : rows) {
    groups.set(row.member, [...(groups.get(row.member) ?? []), row]);
  }
  return [...groups.values()].map((list) => {
    const [first] = list;
    const mine = list.some((row) => row.mine);
    const name = mine ? t('you') : first.name;
    // a person with a single known device has no device name to show
    const named = list.length > 1 || first.device !== null;
    const parts = list.map((row) => {
      const type = stateName(row.state);
      // "this device" names which of ours it is: only needed once there are several
      const how = named && row.self ? `${t('deviceThis')}, ${type}` : type;
      return { text: named ? `${tag(row)} (${how})` : how, state: row.state };
    });
    const title = list.filter((r) => r.sas).map(
      (r) => `${list.length > 1 ? `${tag(r)}: ` : ''}${t('verify')} ${r.sas}`,
    ).join('\n');
    const help = [...new Set(list.map((r) => r.state))]
      .map((state) => `${stateName(state)}: ${stateHelp(state)}`);
    if (mine) help.unshift(t('helpYou'));
    return {
      name, mine, parts, title, help: help.join('\n'),
      state: list.find((r) => r.state === 'p2p')?.state ?? first.state,
      text: named ? `${name}${AT}${parts.map((p) => p.text).join(' | ')}`
        : `${name} (${parts[0].text})`,
    };
  });
}
