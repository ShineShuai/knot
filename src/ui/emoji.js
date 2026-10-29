// The emoji offered for reactions: a quick row, and more behind "+" (none of them repeats the
// quick row). Every one must pass `isEmoji` (envelope.js), which is also what receivers check;
// a test makes sure.
export const QUICK = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

export const MORE = [
  // faces
  '😀', '😁', '🤣', '😊', '😍', '😘', '😎', '🤔', '😅', '😉', '🙃', '😴', '😬', '😭', '😡',
  '🥳', '🤯', '🥺', '😇', '🤗', '😱', '🤩', '😏', '🙄',
  // hands and people
  '👎', '👏', '🙌', '💪', '👀', '🤝', '✌️', '🤞', '👌', '👋', '🤷', '🤦',
  // hearts, celebration, marks
  '🧡', '💛', '💚', '💙', '💜', '🖤', '💔', '💯', '🔥', '✨', '🎉', '🎊', '🏆', '⭐', '💡',
  '✅', '❌', '❓', '❗', '⚠️',
  // things
  '☕', '🍕', '🍺', '🎂', '🚀', '🌈', '☀️', '🐱', '🐶',
];
