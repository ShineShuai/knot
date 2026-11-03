// Names and file names come from other people and are shown as they typed them. Strip what lets
// one pretend to be another: direction marks and overrides (they reverse the end of a file
// name: "photo<RLO>gpj.exe" reads "photoexe.jpg"), invisible marks, control characters.
const HIDDEN =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

/** `text` without the characters that cannot be seen but change what is seen. */
export const plain = (text) => String(text ?? '').replace(HIDDEN, '').trim();
