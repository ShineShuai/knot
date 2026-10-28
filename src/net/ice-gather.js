// Shared by every non-trickle connection: wait until ICE gathering is complete so the
// local description carries all candidates, but never longer than `ms` (a STUN server
// that does not answer must not stall the connection).

/** Resolve once `pc` has gathered all candidates, or after `ms`, whichever is first. */
export function gathered(pc, ms) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => pc.iceGatheringState === 'complete' && done();
    const timer = setTimeout(done, ms);
    pc.addEventListener('icegatheringstatechange', check);
  });
}
