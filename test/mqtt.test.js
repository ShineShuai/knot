import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PacketParser,
  decodePublish,
  encodePublish,
  encodeSubscribe,
  encodeSuback,
  MqttClient,
} from '../src/net/mqtt.js';
import { RoomChannel } from '../src/net/room-channel.js';
import { deriveRoomKeys, newRoomSecret } from '../src/crypto/room-keys.js';
import { newIdentity } from './helpers.js';
import { FakeBroker, until } from './fakes.js';
import { BrokerHealth } from '../src/net/broker-health.js';

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

test('subscribe resolves on SUBACK and rejects on refusal, silence and close', async () => {
  const connect = async (mode, opts) => {
    const client = new MqttClient('wss://fake', { WS: new FakeBroker(mode).ws(), ...opts });
    await client.connect();
    return client;
  };
  const ok = await connect('ok');
  await ok.subscribe('t/1');
  ok.close();
  const refused = await connect('refuse');
  await assert.rejects(refused.subscribe('t/1'), /subscribe refused/);
  refused.close();
  const silent = await connect('silent', { subscribeTimeoutMs: 20 });
  await assert.rejects(silent.subscribe('t/1'), /subscribe timeout/);
  const pending = silent.subscribe('t/2');
  silent.close();
  await assert.rejects(pending, /connection closed/);
  await assert.rejects(silent.subscribe('t/3'), /not connected/);
  assert.deepEqual(
    new PacketParser().push(encodeSuback(0x0102, 0x80))[0],
    { type: 9, flags: 0, body: Uint8Array.of(1, 2, 0x80) },
  );
});

test('roundTrip passes only through a broker that relays', async () => {
  const connect = async (mode) => {
    const client = new MqttClient('wss://fake', {
      WS: new FakeBroker(mode).ws(), subscribeTimeoutMs: 50,
    });
    await client.connect();
    return client;
  };
  const ok = await connect('ok');
  assert.ok(await ok.roundTrip('t/probe', 500) >= 0);
  ok.close();
  for (const [mode, error] of [
    ['drop', /publish not relayed/], ['refuse', /refused/], ['silent', /subscribe timeout/],
  ]) {
    const client = await connect(mode);
    await assert.rejects(client.roundTrip('t/probe', 200), error, mode);
    client.close();
  }
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

test('RoomChannel: a broker that refuses subscriptions is marked down; others carry', async () => {
  const brokers = [['wss://good', 'ok'], ['wss://bad', 'refuse']].map(
    ([url, mode]) => ({ url, broker: new FakeBroker(mode) }),
  );
  const keys = await deriveRoomKeys(newRoomSecret());
  const [ida, idb] = [await newIdentity(), await newIdentity()];
  const health = new BrokerHealth();
  const make = (identity) => new RoomChannel({
    roomId: keys.id, aes: keys.aes, selfId: identity.id, topicPrefix: 't',
    brokers: brokers.map((b) => b.url), health,
    WS: class {
      constructor(url) { return new (brokers.find((b) => b.url === url).broker.ws())(); }
    },
  });
  const [a, b] = [make(ida), make(idb)];
  const got = [];
  b.on('relay', (r) => got.push(r));
  [a, b].forEach((c) => c.start());
  await until(() => health.isDown('wss://bad') && health.rows(['wss://good'])[0].ok);
  const [down] = health.rows(['wss://bad']);
  assert.equal(down.relay, false);
  assert.match(down.error, /no relay: subscribe refused/);
  health.report('wss://bad', 5); // connecting is not enough to clear it
  assert.equal(health.isDown('wss://bad'), true);
  await a.sendRelay(Uint8Array.of(7));
  await until(() => got.length);
  assert.deepEqual(got, [Uint8Array.of(7)]);
  [a, b].forEach((c) => c.stop());
});
