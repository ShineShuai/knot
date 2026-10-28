// One quiet line for a membership change ("Bob joined"), for the conversation and the export.
// `t` is the translate function.
export function noticeLine(room, env, t) {
  const { body } = env;
  const lines = {
    admit: () => t('sysJoined', { name: body.name }),
    revoke: () => t('sysRemoved', { name: room.nameOf(body.id), by: env.name }),
    transfer: () => t('sysOwner', { name: room.nameOf(body.to) }),
    recover: () => t('sysRecovered', { name: env.name }),
  };
  return lines[env.kind]?.() ?? '';
}
