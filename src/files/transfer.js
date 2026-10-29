// Peer-to-peer file transfer on the "files" data channel.
//
// Sharing is announced to the room as a signed "file" chat message (metadata and
// SHA-256 only). A peer who wants the file asks the sharer over the direct link;
// the sharer streams it in chunks. Nothing is stored anywhere in between.
//
// Frames on the file channel (it is ordered, so control and data stay in sequence):
//   text   {"t":"get"|"meta"|"end"|"err", id, ...}
//   binary <8-byte file id><chunk bytes>
import { concat, fromB64u, randomBytes, sha256, toB64u } from '../util/bytes.js';
import { fileBody } from '../chat/envelope.js';
import { deriveImage } from './image.js';

const ID_BYTES = 8;
const IDLE_TIMEOUT_MS = 30000;
const MAX_SERVES = 6; // simultaneous transfers one peer may ask of us on one link

export class FileTransfer {
  #shared = new Map();    // id -> Blob we offered: files, and the previews derived from them
  #downloads = new Map(); // id -> in-flight download state
  #serving = new WeakMap(); // link -> transfers we are serving on it right now
  #chunkSize; #maxBytes; #derive; #lookup;
  /** While true we neither share, serve nor fetch files (a call keeps the bandwidth). */
  paused = false;

  /** `derive(file, bytes)` makes the thumbnail/preview of an image (null for other files);
   *  `lookup(id)` finds a cached Blob to serve when `#shared` does not have it. */
  constructor(
    {
      chunkSize = 16 * 1024,
      maxBytes = 100 * 1024 * 1024,
      derive = deriveImage,
      lookup = async () => null,
    } = {},
  ) {
    this.#chunkSize = chunkSize;
    this.#maxBytes = maxBytes;
    this.#derive = derive;
    this.#lookup = lookup;
  }

  // ---- sharing side ------------------------------------------------------------

  /** Register a file for sharing; returns the metadata to announce. Images also get a
   *  thumbnail (inline in the metadata) and, if big, a preview shared under its own id. */
  async share(file) {
    if (this.paused) throw new Error('File transfers are paused during the call');
    const id = toB64u(randomBytes(ID_BYTES));
    const bytes = new Uint8Array(await file.arrayBuffer());
    const digest = await sha256(bytes);
    this.#shared.set(id, file);
    return fileBody(
      {
        id,
        name: file.name,
        size: file.size,
        mime: file.type || 'application/octet-stream',
        sha256: toB64u(digest),
        img: await this.#renditions(file, bytes),
      },
    );
  }

  /** Thumbnail + preview of an image; the preview is content-addressed (id = hash prefix). */
  async #renditions(file, bytes) {
    let derived = null;
    try { derived = await this.#derive(file, bytes); } catch { /* shared as a plain file */ }
    if (!derived?.preview) return derived?.img ?? null;
    const data = new Uint8Array(await derived.preview.arrayBuffer());
    const digest = await sha256(data);
    const id = toB64u(digest.subarray(0, ID_BYTES));
    this.#shared.set(id, derived.preview);
    const p = { id, size: data.length, mime: derived.preview.type, sha256: toB64u(digest) };
    return { ...derived.img, p };
  }

  /** Stop offering these (their message was deleted). */
  forget(...ids) { for (const id of ids) this.#shared.delete(id); }

  /** The Blob itself, if we shared it (for the sender's own "download" click). */
  local(id) { return this.#shared.get(id) ?? null; }

  async #serve(link, id) {
    if (this.paused) return link.sendFile(JSON.stringify({ t: 'err', id, reason: 'paused' }));
    const busy = this.#serving.get(link) ?? 0;
    if (busy >= MAX_SERVES) {
      return link.sendFile(JSON.stringify({ t: 'err', id, reason: 'busy' }));
    }
    this.#serving.set(link, busy + 1);
    try {
      const file = this.#shared.get(id) ?? await this.#lookup(id).catch(() => null);
      if (!file) {
        return await link.sendFile(JSON.stringify({ t: 'err', id, reason: 'unavailable' }));
      }
      await link.sendFile(JSON.stringify({ t: 'meta', id, size: file.size }));
      const idBytes = fromB64u(id);
      for (let at = 0; at < file.size; at += this.#chunkSize) {
        const chunk = new Uint8Array(await file.slice(at, at + this.#chunkSize).arrayBuffer());
        await link.sendFile(concat(idBytes, chunk));
      }
      await link.sendFile(JSON.stringify({ t: 'end', id }));
    } finally { this.#serving.set(link, (this.#serving.get(link) ?? 1) - 1); }
  }

  // ---- downloading side ----------------------------------------------------------

  /** Ask the sharer on `link` for the file described by `body`. Resolves to a Blob. */
  download(link, body, onProgress = () => {}) {
    if (this.paused) return Promise.reject(new Error('File transfers are paused during the call'));
    if (this.#downloads.has(body.id)) return Promise.reject(new Error('Already downloading'));
    if (body.size > this.#maxBytes) return Promise.reject(new Error('File too large'));
    return new Promise((resolve, reject) => {
      const state = {
        body,
        chunks: [],
        got: 0,
        started: false,
        onProgress,
        resolve,
        reject,
        timer: null,
      };
      const finish = (fn, value) => {
        clearTimeout(state.timer);
        unsubscribe();
        this.#downloads.delete(body.id);
        fn(value);
      };
      state.fail = (err) => finish(reject, err instanceof Error ? err : new Error(String(err)));
      state.done = (blob) => finish(resolve, blob);
      state.touch = () => {
        clearTimeout(state.timer);
        state.timer = setTimeout(() => state.fail(new Error('Transfer stalled')), IDLE_TIMEOUT_MS);
      };
      const unsubscribe = link.on('close', () => state.fail(new Error('Connection closed')));
      this.#downloads.set(body.id, state);
      state.touch();
      link.sendFile(JSON.stringify({ t: 'get', id: body.id })).catch(state.fail);
    });
  }

  // ---- frame router (called for everything arriving on a link's file channel) ---------

  onFrame(link, data) {
    if (typeof data === 'string') return this.#onControl(link, data);
    const bytes = new Uint8Array(data);
    const state = this.#downloads.get(toB64u(bytes.subarray(0, ID_BYTES)));
    if (!state?.started) return;
    const chunk = bytes.slice(ID_BYTES);
    state.got += chunk.length;
    if (state.got > state.body.size) return state.fail(
      new Error('Received more data than announced'),
    );
    state.chunks.push(chunk);
    state.touch();
    state.onProgress(state.got, state.body.size);
  }

  #onControl(link, text) {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (m.t === 'get') return void this.#serve(link, m.id).catch(() => {});
    const state = this.#downloads.get(m.id);
    if (!state) return;
    if (m.t === 'meta') {
      if (m.size !== state.body.size) return state.fail(
        new Error('Size does not match the announcement'),
      );
      state.started = true;
    } else if (m.t === 'err') {
      const why = {
        unavailable: 'The sender no longer has this file',
        busy: 'The sender is busy, try again',
        paused: 'The sender paused file transfers during a call',
      };
      state.fail(new Error(why[m.reason] ?? 'Transfer failed'));
    } else if (m.t === 'end') {
      this.#finish(state);
    }
  }

  async #finish({ body, chunks, got, fail, done }) {
    if (got !== body.size) return fail(new Error('Incomplete transfer'));
    const blob = new Blob(chunks, { type: body.mime });
    const digest = toB64u(await sha256(new Uint8Array(await blob.arrayBuffer())));
    return digest === body.sha256 ? done(blob) : fail(
      new Error('Checksum mismatch: file was corrupted'),
    );
  }
}
