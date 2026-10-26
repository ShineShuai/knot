import test from 'node:test';
import assert from 'node:assert/strict';
import { connLine, connPath } from '../src/ui/conn.js';

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

test('connLine describes how a member is connected', () => {
  const row = { name: 'Bob', state: 'p2p', via: 'manual', net: net('host', 'srflx') };
  assert.equal(
    connLine(row, t),
    'Bob · <connNat> · host ↔ srflx · UDP · 23 ms · <viaManual>',
  );
  assert.equal(connLine({ ...row, net: null, via: 'broker' }, t), 'Bob · <direct> · <viaBroker>');
  assert.equal(connLine({ ...row, net: net('relay', 'host', { rtt: null }) }, t),
    'Bob · <connTurn> · relay ↔ host · UDP · <viaManual>');
  assert.equal(connLine({ name: 'Cy', state: 'relay' }, t), 'Cy · <connRelayOnly>');
  assert.equal(connLine({ name: 'Di', state: 'seen' }, t), 'Di · <connSeen>');
  assert.equal(connLine({ name: 'Ed', state: 'connecting' }, t), 'Ed · <connecting>');
});
