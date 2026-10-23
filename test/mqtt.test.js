import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PacketParser,
  decodePublish,
  encodePublish,
  encodeSubscribe,
  MqttClient,
} from '../src/net/mqtt.js';
import { RoomChannel } from '../src/net/room-channel.js';
import { deriveRoomKeys, newRoomSecret } from '../src/crypto/room-keys.js';
import { newIdentity } from './helpers.js';
import { FakeBroker, until } from './fakes.js';

test('PacketParser reassembles packets split into single bytes and merged frames', () => {
  // forces a 2-byte remaining length
  const payload = Uint8Array.from({ length: 300 }, (_, i) => i % 251);
  const wire = new Uint8Array([...encodePublish('a/b', payload), ...encodeSubscribe(7, 'x/y')]);
  const parser = new PacketParser();
  const packets = [...wire].flatMap((b) => parser.push(Uint8Array.of(b)));
  assert.equal(packets.length, 2);
  const pub = decodePublish(packets[0]);
  assert.equal(pub.topic, 'a/b');
  assert.deepEqual(pub.payload, payload);
  assert.equal(new PacketParser().push(wire).length, 2);
});

test('MqttClient connects, subscribes and receives its own publish', async () => {
  const broker = new FakeBroker();
  const client = new MqttClient('wss://fake', { WS: broker.ws() });
  await client.connect();
  const got = new Promise(
    (resolve) => client.on('message', (topic, payload) => resolve([topic, payload])),
  );
  client.subscribe('t/1');
  await new Promise((r) => setTimeout(r, 5));
  client.publish('t/1', Uint8Array.of(1, 2, 3));
  assert.deepEqual(await got, ['t/1', Uint8Array.of(1, 2, 3)]);
  client.close();
});

test('MqttClient rejects when the socket fails', async () => {
  const WS = class {
    constructor() { queueMicrotask(() => this.onerror?.()); } send() {} close() {}
  };
  await assert.rejects(new MqttClient('wss://down', { WS }).connect(), /socket error/);
});

const makeChannel = async (keys, identity, brokers) => new RoomChannel({
  roomId: keys.id, aes: keys.aes, selfId: identity.id, topicPrefix: 't', brokers: brokers.map(
    (b) => b.url,
  ),
  WS: class {
    constructor(url) { return new (brokers.find((b) => b.url === url).broker.ws())(); }
  },
});

test('RoomChannel: presence, signaling and relay across brokers; needs the room key', async () => {
  const brokers = ['wss://one', 'wss://two'].map((url) => ({ url, broker: new FakeBroker() }));
  const keys = await deriveRoomKeys(newRoomSecret());
  const [ida, idb, ide] = [await newIdentity(), await newIdentity(), await newIdentity()];
  const [a, b] = [await makeChannel(keys, ida, brokers), await makeChannel(keys, idb, brokers)];
  const outsider = await makeChannel(await deriveRoomKeys(newRoomSecret()), ide, brokers);
  const seen = { presence: [], signal: [], relay: [], outsider: 0 };
  b.on('presence', (p) => seen.presence.push(p));
  b.on('signal', (s) => seen.signal.push(s));
  b.on('relay', (r) => seen.relay.push(r));
  outsider.on('presence', () => seen.outsider++);
  outsider.on('relay', () => seen.outsider++);
  [a, b, outsider].forEach((c) => c.start());
  await until(
    () => a.status.connected === 2 && b.status.connected === 2 && outsider.status.connected === 2,
  );

  await a.announce({ pub: ida.pub, name: 'Ada' });
  await a.sendSignal(idb.id, Uint8Array.of(9, 9));
  await a.sendRelay(Uint8Array.of(7));
  await until(() => seen.presence.length && seen.signal.length && seen.relay.length);
  await new Promise((r) => setTimeout(r, 30));

  // de-duplicated across 2 brokers
  assert.deepEqual([seen.presence.length, seen.signal.length, seen.relay.length], [1, 1, 1]);
  assert.equal(seen.presence[0].id, ida.id);
  assert.equal(seen.presence[0].name, 'Ada');
  assert.deepEqual(seen.signal[0], Uint8Array.of(9, 9));
  assert.equal(seen.outsider, 0);
  [a, b, outsider].forEach((c) => c.stop());
});
