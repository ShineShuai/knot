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

const ID_BYTES = 8;
const IDLE_TIMEOUT_MS = 30000;

export class FileTransfer {
  #shared = new Map();    // file id -> File we offered
  #downloads = new Map(); // file id -> in-flight download state
  #chunkSize; #maxBytes;

  constructor({ chunkSize = 16 * 1024, maxBytes = 100 * 1024 * 1024 } = {}) {
    this.#chunkSize = chunkSize;
    this.#maxBytes = maxBytes;
  }

  // ---- sharing side ------------------------------------------------------------

  /** Register a file for sharing; returns the metadata to announce. */
  async share(file) {
    const id = toB64u(randomBytes(ID_BYTES));
    const digest = await sha256(new Uint8Array(await file.arrayBuffer()));
    this.#shared.set(id, file);
    return fileBody(
      {
        id,
        name: file.name,
        size: file.size,
        mime: file.type || 'application/octet-stream',
        sha256: toB64u(digest),
      },
    );
  }

  /** The File itself, if we shared it (for the sender's own "download" click). */
  local(id) { return this.#shared.get(id) ?? null; }

  async #serve(link, id) {
    const file = this.#shared.get(id);
    if (!file) return link.sendFile(JSON.stringify({ t: 'err', id, reason: 'unavailable' }));
    await link.sendFile(JSON.stringify({ t: 'meta', id, size: file.size }));
    const idBytes = fromB64u(id);
    for (let at = 0; at < file.size; at += this.#chunkSize) {
      const chunk = new Uint8Array(await file.slice(at, at + this.#chunkSize).arrayBuffer());
      await link.sendFile(concat(idBytes, chunk));
    }
    await link.sendFile(JSON.stringify({ t: 'end', id }));
  }

  // ---- downloading side ----------------------------------------------------------

  /** Ask the sharer on `link` for the file described by `body`. Resolves to a Blob. */
  download(link, body, onProgress = () => {}) {
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
      state.fail(
        new Error(
          m.reason === 'unavailable' ? 'The sender no longer has this file' : 'Transfer failed',
        ),
      );
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
