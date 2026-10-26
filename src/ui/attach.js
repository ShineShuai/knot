// Getting files into the chat besides the "+" button: paste (screenshots, "copy image",
// files copied in Finder/Explorer) and drag & drop. Pure helpers, no DOM access.
export const MAX_AT_ONCE = 10; // a burst of more would trip the receivers' rate limit

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const GENERIC = /^image\.\w+$/i; // what browsers call a pasted screenshot
const two = (n) => String(n).padStart(2, '0');

/** Browsers name every pasted screenshot "image.png"; give it a recognisable name. */
export function nameClipboardFile(file, now = new Date()) {
  if (file.name && !GENERIC.test(file.name)) return file;
  const day = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`;
  const time = `${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  const ext = EXT[file.type] ?? (file.type.split('/')[1] || 'bin');
  return new File([file], `pasted-${day}-${time}.${ext}`, { type: file.type });
}

/**
 * Files on the clipboard. Text copied from Office or a web page also carries an image of
 * itself; when rich text is present the text wins and nothing is intercepted.
 */
export function clipboardFiles(data) {
  const files = [...(data?.files ?? [])];
  const rich = [...(data?.types ?? [])].includes('text/html')
    && data.getData('text/plain').trim() !== '';
  return rich ? [] : files.map((file) => nameClipboardFile(file));
}

/** Files of a drop, and how many folders were skipped (a folder cannot be read as a file).
 *  Must run inside the drop event: the entries are gone afterwards. */
export function droppedFiles(data) {
  const items = [...(data?.items ?? [])].filter((item) => item.kind === 'file');
  if (!items.length) return { files: [...(data?.files ?? [])], folders: 0 };
  const files = [];
  let folders = 0;
  for (const item of items) {
    if (item.webkitGetAsEntry?.()?.isDirectory) folders++;
    else {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return { files, folders };
}

export const dragHasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files');
