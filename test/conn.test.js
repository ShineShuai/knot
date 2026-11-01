import test from 'node:test';
import assert from 'node:assert/strict';
import { connLine, connPath, selfLine } from '../src/ui/conn.js';

const t = (key) => `<${key}>`;
const net = (local, remote, extra = {}) => ({ local, remote, protocol: 'udp', rtt: 23, ...extra });

test('connPath classifies the selected candidate pair', () => {
  assert.equal(connPath(net('host', 'host')), 'host');
  assert.equal(connPath(net('host', 'srflx')), 'nat');
  assert.equal(connPath(net('prflx', 'host')), 'nat');
  assert.equal(connPath(net('srflx', 'relay')), 'relay');
  assert.equal(connPath(net('relay', 'host')), 'relay');
  assert.equal(connPath(null), null);
  assert.equal(connPath({ local: null, remote: null }), null);
});

test('connLine describes how a member is connected, written like the bar', () => {
  const row = { name: 'Bob', state: 'p2p', via: 'manual', net: net('host', 'srflx') };
  assert.equal(
    connLine(row, t),
    'Bob (<connNat>): host ↔ srflx, UDP, 23 ms, <viaManual>',
  );
  assert.equal(connLine({ ...row, net: null, via: 'broker' }, t), 'Bob (<direct>): <viaBroker>');
  assert.equal(connLine({ ...row, net: net('relay', 'host', { rtt: null }) }, t),
    'Bob (<connTurn>): relay ↔ host, UDP, <viaManual>');
  assert.equal(connLine({ name: 'Cy', state: 'relay' }, t), 'Cy (<connRelayOnly>)');
  assert.equal(connLine({ name: 'Di', state: 'seen' }, t), 'Di (<connSeen>)');
  assert.equal(connLine({ name: 'Ed', state: 'connecting' }, t), 'Ed (<connecting>)');
  assert.equal(connLine({ label: 'Ada @ phone', name: 'Ada', state: 'relay' }, t),
    'Ada @ phone (<connRelayOnly>)', 'the label (name and device) is what is shown');
});

test('selfLine says how this device reaches the room', () => {
  const brokers = { n: 2, m: 3 };
  assert.equal(selfLine({ label: 'You @ main', state: 'p2p', brokers }, t),
    'You @ main (<deviceThis>, <direct>): <brokers>');
  assert.equal(selfLine({ label: 'You', state: 'relay', brokers }, t),
    'You (<deviceThis>, <relay>): <brokers>');
  assert.equal(selfLine({ label: 'You', state: 'offline', brokers }, t),
    'You (<deviceThis>, <offlineState>): <brokers>');
});
