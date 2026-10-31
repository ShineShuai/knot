// Save a room's history: readable text, or the signed envelopes as they are (so anyone can
// check them). Only what this device holds; shared files themselves are not included.
import { ADMIN_KINDS, authorIdOf, deviceNameOf } from '../chat/envelope.js';
import { noticeLine } from '../chat/notice.js';
import { VERSION } from '../version.js';
import { withDevice } from './alias.js';
import { fmtSize } from './dom.js';
import { t } from './i18n.js';

const pad = (n) => String(n).padStart(2, '0');
const stamp = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const indent = (text) => text.replace(/\n/g, '\n    ');

export function exportText(room, now = Date.now()) {
  const { reactions } = room.log.overlay();
  const lines = [
    room.label || t('roomDefault'),
    t('exportedOn', { date: stamp(now), name: room.nameOf(room.identity.id) }),
    '',
  ];
  for (const env of room.log.timeline()) {
    const at = `[${stamp(env.ms)}]`;
    if (env.kind === 'gone') {
      lines.push(`${at} * ${room.isMine(env.by)
        ? t('youDeleted') : t('deletedBy', { name: env.name })}`);
      continue;
    }
    if (ADMIN_KINDS.includes(env.kind)) {
      lines.push(`${at} * ${noticeLine(room, env, t)}`);
      continue;
    }
    const name = withDevice(env.name, room.deviceOf(authorIdOf(env), deviceNameOf(env)));
    const who = room.log.isEdited(env) ? `${name} (${t('edited')})` : name;
    if (env.kind === 'file') {
      lines.push(`${at} ${who}: [${t('exportFile')}] ${env.body.name} (${fmtSize(env.body.size)})`);
    } else {
      lines.push(`${at} ${who}: ${indent(room.log.textOf(env))}`);
      if (env.kind === 'reply') lines.push(`    > ${env.body.q.name}: ${env.body.q.text}`);
    }
    const reacted = [...(reactions.get(env.id) ?? [])].map(
      ([emoji, ids]) => `${emoji} ${ids.map((id) => room.nameOf(id)).join(', ')}`,
    );
    if (reacted.length) lines.push(`    ${reacted.join('   ')}`);
  }
  return `${lines.join('\n')}\n`;
}

export function exportJson(room, now = Date.now()) {
  return JSON.stringify({
    format: 'knot-history',
    app: VERSION,
    room: { id: room.id, label: room.label },
    exportedAt: new Date(now).toISOString(),
    messages: room.log.list(),
  }, null, 2);
}
