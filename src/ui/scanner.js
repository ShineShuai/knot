// Camera QR scanning via the BarcodeDetector API (Chrome/Edge/Android/Safari 17+).
// Where it is missing the UI falls back to paste / copy.
export const canScan = () => 'BarcodeDetector' in globalThis &&
  !!navigator.mediaDevices?.getUserMedia;

/** Opens the camera inside `video` and resolves with the first QR text found; call the returned
 * stop() to cancel. */
export function scanQr(video, onText) {
  let stopped = false, stream;
  const stop = () => {
    stopped = true;
    stream?.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };
  (async () => {
    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    if (stopped) return stop();
    video.srcObject = stream;
    await video.play();
    while (!stopped) {
      const [hit] = await detector.detect(video).catch(() => []);
      if (hit) { stop(); return onText(hit.rawValue); }
      await new Promise((r) => setTimeout(r, 250));
    }
  })().catch((err) => { stop(); onText(null, err); });
  return stop;
}
