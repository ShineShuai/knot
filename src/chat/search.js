// Search through the messages this device holds (the log, up to `logCap` of them).
const KINDS = ['text', 'reply', 'file'];

/** Lower case, without accents, so "cafe" finds "Café". */
const fold = (s) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

/** Messages (newest last) whose current text, or file name, contains every word of `query`. */
export function searchLog(room, query, limit = 200) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const haystack = (env) => fold(env.kind === 'file' ? env.body.name : room.log.textOf(env));
  const hits = room.log.list().filter(
    (env) => KINDS.includes(env.kind) && words.every((word) => haystack(env).includes(word)),
  );
  return hits.slice(-limit);
}
