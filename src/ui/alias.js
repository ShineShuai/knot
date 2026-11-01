// A name with the device it comes from, once a person uses several: "Ada · phone".
import { t } from './i18n.js';

/** `device`: null (one device: the plain name), '' (the main device) or a device's name. */
export const withDevice = (name, device) => (
  device === null || device === undefined ? name : `${name} · ${device || t('deviceMain')}`
);

/** Who a live connection (or this device, with our own id) is, for the bar and for calls. */
export const peerLabel = (room, id) => withDevice(room.nameOf(id), room.peerDevice(id));

const STATES = { p2p: 'direct', online: 'onlineState', offline: 'offlineState' };
const stateText = (state) => t(STATES[state] ?? state);
const tag = (row) => (row.device ?? '') || t('deviceMain');

/** The connection bar: one entry per person, however many of their devices are connected, and
 *  one for ourselves (`self`: Room.selfRow), shown as "You" whether we have linked devices or
 *  not. After the name a colon, then each device with its connection in brackets:
 *    Bob: direct
 *    You: online
 *    Ada: main (online) | mac (direct) | pixel (relay)
 *  `rows`: Room.peerList. An entry is { name, mine, state (the best connection), text, parts
 *  ({ text, state } per device, each drawn in the colour of its connection), title (the
 *  digits to verify) }. */
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
    const parts = list.map((row) => ({
      text: named ? `${tag(row)} (${stateText(row.state)})` : stateText(row.state),
      state: row.state,
    }));
    const title = list.filter((r) => r.sas).map(
      (r) => `${list.length > 1 ? `${tag(r)}: ` : ''}${t('verify')} ${r.sas}`,
    ).join('\n');
    return {
      name, mine, parts, title,
      state: list.find((r) => r.state === 'p2p')?.state ?? first.state,
      text: `${name}: ${parts.map((p) => p.text).join(' | ')}`,
    };
  });
}
