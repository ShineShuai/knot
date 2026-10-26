// One WebRTC connection to one peer, reduced to what the app needs:
//   - two pre-negotiated data channels ("chat" id 0, "files" id 1, so no
//     in-band negotiation and bulk data never blocks chat)
//   - non-trickle signaling: createOffer / acceptOffer / acceptAnswer exchange
//     complete SdpInfo objects (see sdp.js)
// Events: 'open', 'close', 'chat'(string), 'file'(string | ArrayBuffer)
import { Emitter } from '../util/emitter.js';
import { buildSdp, parseSdp } from './sdp.js';

const BUFFER_HIGH = 4 * 1024 * 1024;
const BUFFER_LOW = 1024 * 1024;

export class PeerLink extends Emitter {
  state = 'connecting'; // connecting | open | closed
  #pc; #chat; #files; #gatherMs;

  constructor(
    { iceServers = [], gatherTimeoutMs = 3000, RTC = globalThis.RTCPeerConnection } = {},
  ) {
    super();
    this.#gatherMs = gatherTimeoutMs;
    this.#pc = new RTC({ iceServers });
    this.#chat = this.#pc.createDataChannel('chat', { negotiated: true, id: 0 });
    this.#files = this.#pc.createDataChannel('files', { negotiated: true, id: 1 });
    this.#files.binaryType = 'arraybuffer';
    this.#files.bufferedAmountLowThreshold = BUFFER_LOW;
    this.#chat.onmessage = (e) => typeof e.data === 'string' && this.emit('chat', e.data);
    this.#files.onmessage = (e) => this.emit('file', e.data);
    for (const ch of [this.#chat, this.#files]) {
      ch.onopen = () => this.#maybeOpen();
      ch.onclose = () => this.close();
    }
    this.#pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(this.#pc.connectionState)) this.close();
    };
  }

  // ---- signaling -------------------------------------------------------------

  async createOffer() {
    await this.#pc.setLocalDescription(await this.#pc.createOffer());
    return this.#localInfo();
  }

  async acceptOffer(info) {
    await this.#pc.setRemoteDescription({ type: 'offer', sdp: buildSdp(info, 'offer') });
    await this.#pc.setLocalDescription(await this.#pc.createAnswer());
    return this.#localInfo();
  }

  async acceptAnswer(info) {
    await this.#pc.setRemoteDescription({ type: 'answer', sdp: buildSdp(info, 'answer') });
  }

  async #localInfo() {
    await this.#gathered();
    return parseSdp(this.#pc.localDescription.sdp);
  }

  #gathered() {
    const pc = this.#pc;
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const done = () => {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      };
      const check = () => pc.iceGatheringState === 'complete' && done();
      const timer = setTimeout(done, this.#gatherMs);
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  // ---- data --------------------------------------------------------------------

  sendChat(text) {
    if (this.state !== 'open') throw new Error('link is not open');
    this.#chat.send(text);
  }

  /** Send a string or ArrayBuffer on the file channel, waiting while the buffer is full. */
  async sendFile(data) {
    while (this.state === 'open' && this.#files.bufferedAmount > BUFFER_HIGH) {
      await new Promise((resolve) => {
        const off = () => {
          this.#files.removeEventListener('bufferedamountlow', off);
          resolve();
        };
        this.#files.addEventListener('bufferedamountlow', off);
        this.on('close', off);
      });
    }
    if (this.state !== 'open') throw new Error('link closed');
    this.#files.send(data);
  }

  /** How the connection is routed right now: candidate types (host, srflx, prflx,
   *  relay), transport protocol and round-trip time; null while unknown. */
  async stats() {
    const byId = new Map();
    (await this.#pc.getStats()).forEach((s) => byId.set(s.id, s));
    const all = [...byId.values()];
    const selected = byId.get(all.find((s) => s.type === 'transport')?.selectedCandidatePairId)
      ?? all.find((s) => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded');
    if (!selected) return null;
    const local = byId.get(selected.localCandidateId);
    const remote = byId.get(selected.remoteCandidateId);
    const rtt = selected.currentRoundTripTime;
    return {
      local: local?.candidateType ?? null,
      remote: remote?.candidateType ?? null,
      protocol: local?.protocol ?? null,
      rtt: typeof rtt === 'number' ? Math.round(rtt * 1000) : null,
    };
  }

  close() {
    if (this.state === 'closed') return;
    this.state = 'closed';
    try {
      this.#chat.close();
      this.#files.close();
      this.#pc.close();
    } catch { /* already closed */ }
    this.emit('close');
  }

  #maybeOpen() {
    if (this.state === 'connecting' && this.#chat.readyState === 'open' &&
      this.#files.readyState === 'open') {
      this.state = 'open';
      this.emit('open');
    }
  }
}
