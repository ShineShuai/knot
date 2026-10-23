import { MemoryKV } from '../src/store/kv.js';
import { loadIdentity } from '../src/crypto/identity.js';

export const newIdentity = async () => loadIdentity(new MemoryKV());

/** A realistic Chrome data-channel SDP (candidate list covers every address kind). */
export function sampleSdp({ fp = Array.from({ length: 32 }, (_, i) => i * 7 % 256) } = {}) {
  const hex = fp.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
  return [
    'v=0',
    'o=- 8392754291013457382 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=extmap-allow-mixed',
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    'a=candidate:1 1 udp 2113937151 d3b1c8a4-6a77-4a0e-9a5c-0e5d1f2c3b4a.local 53412 typ host',
    'a=candidate:2 1 udp 1677729535 203.0.113.7 53412 typ srflx raddr 0.0.0.0 rport 0',
    'a=candidate:3 1 udp 2113939711 2001:db8::1234 40000 typ host',
    'a=candidate:4 1 tcp 1518280447 192.168.1.5 9 typ host tcptype active',
    'a=candidate:5 1 udp 2113937150 fe80::1 40001 typ host',
    'a=ice-ufrag:abcd',
    'a=ice-pwd:0123456789abcdefghijklmn',
    'a=ice-options:trickle',
    `a=fingerprint:sha-256 ${hex}`,
    'a=setup:actpass',
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
    '',
  ].join('\r\n');
}
