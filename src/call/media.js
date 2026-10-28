// Microphone and camera access. Kept apart so tests (and other platforms) can swap it:
// anything with `available()` and `getTrack(kind)` will do.

const CONSTRAINTS = {
  audio: { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } },
  // Modest on purpose: in a mesh every sender encodes once per receiver.
  video: {
    video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 } },
  },
};

export const browserMedia = {
  /** Needs a secure page (HTTPS or localhost) and WebRTC. */
  available: () => !!globalThis.navigator?.mediaDevices?.getUserMedia
    && !!globalThis.RTCPeerConnection,

  /** One live track of `kind` ('audio' | 'video'); rejects if refused or missing. */
  async getTrack(kind) {
    const stream = await navigator.mediaDevices.getUserMedia(CONSTRAINTS[kind]);
    return stream.getTracks()[0];
  },
};
