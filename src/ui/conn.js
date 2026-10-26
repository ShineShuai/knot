// Text for the hold-V connection reveal: how each member is connected to us.

/** host: direct without NAT, nat: direct through NAT, relay: via a TURN server. */
export function connPath(net) {
  if (!net?.local || !net.remote) return null;
  if (net.local === 'relay' || net.remote === 'relay') return 'relay';
  return net.local === 'host' && net.remote === 'host' ? 'host' : 'nat';
}

const PATH_KEY = { host: 'connHost', nat: 'connNat', relay: 'connTurn' };

/** One line for a row of Room.connectionInfo(); `t` is the translate function. */
export function connLine({ name, state, via, net }, t) {
  const how = via === 'manual' ? t('viaManual') : via === 'broker' ? t('viaBroker') : '';
  let parts;
  if (state === 'p2p') {
    const path = connPath(net);
    parts = [
      path ? t(PATH_KEY[path]) : t('direct'),
      net?.local ? `${net.local} ↔ ${net.remote}` : '',
      net?.protocol?.toUpperCase() ?? '',
      typeof net?.rtt === 'number' ? `${net.rtt} ms` : '',
      how,
    ];
  } else {
    const key = { relay: 'connRelayOnly', seen: 'connSeen', connecting: 'connecting' }[state];
    parts = [t(key ?? state)];
  }
  return `${name} · ${parts.filter(Boolean).join(' · ')}`;
}
