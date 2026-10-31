// A name with the device it comes from, once a person uses several: "Ada · phone".
import { t } from './i18n.js';

/** `device`: null (one device: the plain name), '' (the main device) or a device's name. */
export const withDevice = (name, device) => (
  device === null || device === undefined ? name : `${name} · ${device || t('deviceMain')}`
);

/** Who a live connection (or this device, with our own id) is, for the bar and for calls. */
export const peerLabel = (room, id) => withDevice(room.nameOf(id), room.peerDevice(id));

const stateText = (state) => t(state === 'p2p' ? 'direct' : state);
const tag = (row) => (row.device ?? '') || t('deviceMain');

/** The connection bar: one entry per person, however many of their devices are connected.
 *  "Bob · direct", or "Ada · main direct | mac relay". `rows`: Room.peerList. Each entry is
 *  { state (the best connection, for the colour), text, title (the digits to verify) }. */
export function peerEntries(rows) {
  const groups = new Map();
  for (const row of rows) groups.set(row.member, [...(groups.get(row.member) ?? []), row]);
  return [...groups.values()].map((list) => {
    const [first] = list;
    const text = list.length === 1
      ? `${withDevice(first.name, first.device)} · ${stateText(first.state)}`
      : `${first.name} · ${list.map((r) => `${tag(r)} ${stateText(r.state)}`).join(' | ')}`;
    const title = list.filter((r) => r.sas).map(
      (r) => `${list.length > 1 ? `${tag(r)}: ` : ''}${t('verify')} ${r.sas}`,
    ).join('\n');
    return { state: list.find((r) => r.state === 'p2p')?.state ?? first.state, text, title };
  });
}
