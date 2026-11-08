// One quiet line for a membership change ("Bob joined"), for the conversation and the export.
// `t` is the translate function.
import { plain } from '../util/text.js';

export function noticeLine(room, env, t) {
  const { body } = env;
  const lines = {
    admit: () => t('sysJoined', { name: plain(body.name) }),
    revoke: () => t('sysRemoved', { name: plain(room.nameOf(body.id)), by: plain(env.name) }),
    transfer: () => t('sysOwner', { name: plain(room.nameOf(body.to)) }),
    recover: () => t('sysRecovered', { name: plain(env.name) }),
    policy: () => t('sysRules', { name: plain(env.name) }),
  };
  return lines[env.kind]?.() ?? '';
}
