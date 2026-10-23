// SDP <-> compact "SdpInfo". A data-channel-only SDP carries just a handful of
// facts; extracting them lets us ship ~200 bytes instead of ~800 and rebuild a
// browser-acceptable SDP on the other side.
//
// SdpInfo: { ufrag, pwd, mid, fingerprint:Uint8Array(32), sctpPort, maxMessage,
//            candidates:[{ type:'host'|'srflx'|'relay'|'prflx', host:string, port:number }] }

const TYPE_PREFERENCE = { host: 126, prflx: 110, srflx: 100, relay: 0 };
const CANDIDATE_TYPES = Object.keys(TYPE_PREFERENCE);

export function parseSdp(sdp) {
  const lines = sdp.split(/\r?\n/);
  const attr = (name) => lines.find((l) => l.startsWith(`a=${name}:`))?.slice(name.length + 3);
  const fp = /^a=fingerprint:sha-256 (.+)$/im.exec(sdp)?.[1];
  if (!fp) throw new Error('SDP has no sha-256 fingerprint');
  const info = {
    ufrag: attr('ice-ufrag'),
    pwd: attr('ice-pwd'),
    mid: attr('mid') ?? '0',
    fingerprint: Uint8Array.from(fp.trim().split(':').map((h) => parseInt(h, 16))),
    sctpPort: Number(attr('sctp-port') ?? 5000),
    maxMessage: Number(attr('max-message-size') ?? 65536),
    candidates: lines.filter(
      (l) => l.startsWith('a=candidate:'),
    ).map(parseCandidate).filter(Boolean),
  };
  if (!info.ufrag || !info.pwd) throw new Error('SDP has no ICE credentials');
  return info;
}

// a=candidate:<foundation> <component> <proto> <priority> <host> <port> typ <type> ...
function parseCandidate(line) {
  const f = line.slice('a=candidate:'.length).trim().split(/\s+/);
  const [, component, proto, , host, port, , type] = f;
  if (component !== '1' || proto?.toLowerCase() !== 'udp' ||
    !CANDIDATE_TYPES.includes(type)) return null;
  return { type, host, port: Number(port) };
}

/** Rebuild a full SDP. `role` is the role of the description being built. */
export function buildSdp(info, role) {
  const fp = [...info.fingerprint].map(
    (b) => b.toString(16).padStart(2, '0').toUpperCase(),
  ).join(':');
  const candidates = info.candidates.map((c, i) => {
    const priority = TYPE_PREFERENCE[c.type] * 2 ** 24 + (65535 - i) * 256 + 255;
    const related = c.type === 'host' ? '' : ' raddr 0.0.0.0 rport 0';
    return `a=candidate:${i + 1} 1 udp ${priority} ${c.host} ${c.port} typ ${c.type}${related}`;
  });
  return [
    'v=0',
    `o=- ${Date.now()} 2 IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    `a=group:BUNDLE ${info.mid}`,
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${info.ufrag}`,
    `a=ice-pwd:${info.pwd}`,
    `a=fingerprint:sha-256 ${fp}`,
    `a=setup:${role === 'offer' ? 'actpass' : 'active'}`,
    `a=mid:${info.mid}`,
    `a=sctp-port:${info.sctpPort}`,
    `a=max-message-size:${info.maxMessage}`,
    ...candidates,
    'a=end-of-candidates',
    '',
  ].join('\r\n');
}
