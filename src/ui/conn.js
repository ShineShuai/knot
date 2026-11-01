// Text for the hold-V connection reveal: how each member is connected to us.

/** host: direct without NAT, nat: direct through NAT, relay: via a TURN server. */
export function connPath(net) {
  if (!net?.local || !net.remote) return null;
  if (net.local === 'relay' || net.remote === 'relay') return 'relay';
  return net.local === 'host' && net.remote === 'host' ? 'host' : 'nat';
}

const PATH_KEY = { host: 'connHost', nat: 'connNat', relay: 'connTurn' };

/** One line for a row of Room.connectionInfo(), written like the bar: who (`label`: the name,
 *  with " @ device" for a person with several), how we are connected in brackets, then the
 *  details. `t` is the translate function.
 *    Bob (direct, through NAT): host ↔ srflx, UDP, 23 ms, paired by code
 *    Ada @ phone (no direct link, text goes through brokers) */
export function connLine({ label, name, state, via, net }, t) {
  const who = label ?? name;
  if (state !== 'p2p') {
    const key = { relay: 'connRelayOnly', seen: 'connSeen', connecting: 'connecting' }[state];
    return `${who} (${t(key ?? state)})`;
  }
  const path = connPath(net);
  const how = via === 'manual' ? t('viaManual') : via === 'broker' ? t('viaBroker') : '';
  const details = [
    net?.local ? `${net.local} ↔ ${net.remote}` : '',
    net?.protocol?.toUpperCase() ?? '',
    typeof net?.rtt === 'number' ? `${net.rtt} ms` : '',
    how,
  ].filter(Boolean);
  const type = path ? t(PATH_KEY[path]) : t('direct');
  return details.length ? `${who} (${type}): ${details.join(', ')}` : `${who} (${type})`;
}

/** The line about this device: its connection type (see Room.selfRow) and the brokers it
 *  reaches. */
export function selfLine({ label, state, brokers }, t) {
  const type = t({ p2p: 'direct', offline: 'offlineState' }[state] ?? state);
  return `${label} (${t('deviceThis')}, ${type}): ${t('brokers', brokers)}`;
}
