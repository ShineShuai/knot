// Open (ownerless) rooms over fake links, for tests that need a few connected members.
import { Room } from '../src/chat/room.js';
import { DEFAULTS } from '../src/config.js';
import { decodeCode } from '../src/net/handshake.js';
import { newRoomSecret } from '../src/crypto/room-keys.js';
import { MemoryKV } from '../src/store/kv.js';
import { newIdentity } from './helpers.js';
import { FakeLink, until } from './fakes.js';

const made = [];
export const stopRooms = () => made.splice(0).forEach((r) => r.stop());

/** One room; pass `secret`, `kv` and `identity` again to reopen the same device's room. */
export async function makeRoom({
  secret = newRoomSecret(), name = 'Ada', kv = new MemoryKV(), identity, extra = {},
} = {}) {
  const settings = {
    ...DEFAULTS, name, brokersEnabled: false, brokers: [], gatherTimeoutMs: 10,
    connectTimeoutMs: 2000, adminTimeoutMs: 400, ...extra,
  };
  const room = await Room.open({
    identity: identity ?? await newIdentity(), secret, label: name, kv, settings,
    iceServers: () => [], linkFactory: () => new FakeLink(),
  });
  made.push(room);
  return room;
}

const p2p = (room) => room.peerList.filter((p) => p.state === 'p2p').length;

/** Link two rooms of one secret by pairing codes and wait until both see each other. */
export async function link(a, b) {
  const offer = decodeCode((await a.createInvite()).code);
  await a.acceptAnswer(decodeCode((await b.answerOffer(offer)).code));
  await until(() => p2p(a) >= 1 && p2p(b) >= 1);
}

/** Two linked rooms [a, b] in one room. */
export async function pairRooms(names = ['Ada', 'Bob']) {
  const secret = newRoomSecret();
  const a = await makeRoom({ secret, name: names[0] });
  const b = await makeRoom({ secret, name: names[1] });
  await link(a, b);
  return [a, b];
}

export const texts = (room) => room.log.list().filter((e) => e.kind === 'text').map((e) => e.body);
