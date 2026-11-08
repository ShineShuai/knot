// What the owner decides for a whole room ("rules"), and how a room holds them. The rules are
// one signed envelope of the owner, `policy` { rev, rules }: the one with the highest `rev` wins
// (the same `rev`: the greater id) and replaces the older one. They are not part of the member
// chain (roster.js): a version that does not know them drops the envelope and goes on following
// the chain. A rule is enforced by every honest member on what comes in (and by the sender's
// own app on what goes out); a modified app can ignore it, as it can ignore any other check.
import { compareStamps } from '../util/hlc.js';

export const POLICY = 'policy';

/** The rules of a room that never had any: everyone may do everything; the owner lets people in. */
export const DEFAULT_RULES = Object.freeze({
  join: 'approve', post: 'all', files: true, calls: true,
});

const isBool = (v) => typeof v === 'boolean';
const CHECKS = {
  join: (v) => ['approve', 'closed'].includes(v), // closed: the owner does not answer join requests
  post: (v) => ['all', 'owner'].includes(v), // owner: only the owner writes (an announcement room)
  files: isBool,
  calls: isBool,
};
const POSTS = ['text', 'reply', 'file']; // what `post: 'owner'` keeps from everyone else

/** The rules as given: a missing or invalid one is the default; unknown ones are left out. */
export const rulesOf = (rules = {}) => Object.fromEntries(Object.keys(DEFAULT_RULES).map(
  (key) => [key, key in rules && CHECKS[key](rules[key]) ? rules[key] : DEFAULT_RULES[key]],
));

/** Body of a `policy` envelope. The key order is fixed: the signature covers it. */
export const policyBody = (rev, rules) => ({ rev, rules: rulesOf(rules) });

/** Is `body` a well-formed `policy` body? Rules we know must be valid; others are for newer
 *  versions of the app and are only bounded (they stay in the envelope, and are ignored here). */
export function validPolicyBody(body) {
  if (!body || typeof body !== 'object' || !Number.isSafeInteger(body.rev)) return false;
  if (body.rev < 1 || body.rev > 1e6) return false;
  const { rules } = body;
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return false;
  const keys = Object.keys(rules);
  const simple = ['string', 'boolean', 'number'];
  const bounded = (v) => simple.includes(typeof v) && String(v).length <= 32;
  return keys.length <= 16 && keys.every(
    (key) => (key in CHECKS ? CHECKS[key](rules[key]) : bounded(rules[key])),
  );
}

export class Policy {
  rev = 0;
  rules = { ...DEFAULT_RULES };
  env = null; // the envelope that set them

  /** Do the rules differ from the defaults? */
  get custom() {
    return Object.keys(DEFAULT_RULES).some((key) => this.rules[key] !== DEFAULT_RULES[key]);
  }

  /** Would `env` replace what we hold? (It must be checked already: signature, and that the
   *  current owner signed it.) */
  supersedes(env) {
    const { rev } = env.body;
    return rev > this.rev || (rev === this.rev && !!this.env && env.id > this.env.id);
  }

  set(env) {
    this.rev = env.body.rev;
    this.rules = rulesOf(env.body.rules);
    this.env = env;
  }

  /** Why would a message of this `kind` from `author` be refused now? 'files', 'post' or null. */
  denies(kind, author, owner) {
    if (kind === 'file' && !this.rules.files) return 'files';
    if (POSTS.includes(kind) && this.rules.post === 'owner' && author !== owner) return 'post';
    return null;
  }

  /** May this envelope in? Only what was written after the rules were set is judged: before,
   *  we cannot know what they were, and history must not lose messages when the rules change. */
  permits(env, author, owner) {
    const stamp = (e) => ({ ms: e.ms, c: e.c });
    if (!this.env || compareStamps(stamp(env), stamp(this.env)) <= 0) return true;
    return this.denies(env.kind, author, owner) === null;
  }
}
