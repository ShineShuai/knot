// A name with the device it comes from, once a person uses several: "Ada · phone".
import { t } from './i18n.js';

/** `device`: null (one device: the plain name), '' (the main device) or a device's name. */
export const withDevice = (name, device) => (
  device === null || device === undefined ? name : `${name} · ${device || t('deviceMain')}`
);

/** Who a live connection (or this device, with our own id) is, for the bar and for calls. */
export const peerLabel = (room, id) => withDevice(room.nameOf(id), room.peerDevice(id));
