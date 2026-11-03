// A WebRTC link that stays 'disconnected' is dead: close it, so the room falls back and redials.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PeerLink } from '../src/net/peer-link.js';
import { until } from './fakes.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));



test('a link that stays disconnected is closed after a grace period', async () => {
  let pc;
  class RTC {
    connectionState = 'connected';
    constructor() { pc = this; }
    createDataChannel() { return { readyState: 'open', close() {} }; }
    close() {}
  }
  const link = new PeerLink({ RTC, disconnectGraceMs: 100 });
  link.state = 'open';
  let closed = 0;
  link.on('close', () => closed++);
  pc.connectionState = 'disconnected'; pc.onconnectionstatechange();
  pc.connectionState = 'connected'; pc.onconnectionstatechange(); // healed in time
  await wait(250);
  assert.equal(closed, 0);
  pc.connectionState = 'disconnected'; pc.onconnectionstatechange();
  await until(() => closed === 1);
  assert.equal(link.state, 'closed');
});
