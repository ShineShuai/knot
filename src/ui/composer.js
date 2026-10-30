// The message box: text, replies, edits, and the files waiting in it to be sent (picker,
// paste, drop). Sending happens here; the conversation above it is drawn by the page.
import { quoteOf } from '../chat/envelope.js';
import {
  MAX_AT_ONCE, clipboardFiles, dragHasFiles, droppedFiles, stageFiles,
} from './attach.js';
import { fmtSize, h } from './dom.js';
import { t } from './i18n.js';

export class Composer {
  #quote = null;         // envelope the composer is replying to
  #editing = null;       // our own envelope the message box is changing (instead of a new one)
  #input = null;         // the textarea
  #staged = new Map();   // room id -> files waiting in the message box to be sent
  #chipUrls = new Map(); // staged File -> object URL of its little preview
  #drawQuote = () => {};
  #fitInput = () => {};  // resize the message box to its text
  #drawStaged = () => {};

  constructor(ui) {
    this.ui = ui;
  }

  /** A new stage is drawn: nothing is being replied to or edited. */
  reset() {
    this.#quote = null;
    this.#editing = null;
  }

  /** The room was left: forget what was staged for it. */
  forget(room) {
    for (const file of this.#staged.get(room.id) ?? []) this.remove(room, file);
    this.#staged.delete(room.id);
  }

  /**
   * The message box of `room` as { quoteBar, chips, bar, draw } for the page to place.
   * `keepBottom(change)` runs a change and keeps the newest messages in view if they were;
   * `drawLog(stick)` redraws the conversation.
   */
  mount(room, { keepBottom, drawLog }) {
    const { ui } = this;
    const input = h('textarea', {
      rows: 1,
      placeholder: t('typeMessage'),
      maxLength: room.settings.maxTextLength,
      'aria-label': t('typeMessage'),
    });
    this.#input = input;
    /** Grow the message box with its text; CSS caps it so the chat above stays visible. */
    const fit = () => keepBottom(() => {
      input.style.height = 'auto';
      input.style.height = `${input.scrollHeight + input.offsetHeight - input.clientHeight}px`;
    });
    input.addEventListener('input', fit);
    const picker = h('input', {
      type: 'file',
      multiple: true,
      hidden: true,
      onchange: () => {
        this.add(room, [...picker.files]);
        picker.value = '';
      },
    });
    const quoteBar = h('div', { class: 'quote-bar', hidden: true });
    const chips = h('div', { class: 'attachments', hidden: true });
    this.#drawStaged = () => keepBottom(() => {
      const files = this.#staged.get(room.id) ?? [];
      chips.hidden = !files.length;
      chips.replaceChildren(...files.map((file) => this.#chip(room, file)));
    });
    const drawQuote = () => keepBottom(() => {
      const editing = this.#editing;
      const q = editing ?? this.#quote;
      quoteBar.hidden = !q;
      const cancel = t(editing ? 'editCancel' : 'quoteCancel');
      quoteBar.replaceChildren(...(q ? [
        h('span', { class: 'quote-text' }, h('b', {}, editing ? t('editing') : q.name), ' ',
          quoteOf(q, q.kind === 'file' ? null : room.log.textOf(q)).text),
        h('button', {
          class: 'ghost', title: cancel, 'aria-label': cancel,
          onclick: () => (editing ? this.cancelEdit() : this.setQuote(null)),
        }, '×'),
      ] : []));
    });
    this.#drawQuote = drawQuote;
    this.#fitInput = fit;

    const sendButton = h('button', { class: 'primary', onclick: () => send() }, t('send'));
    let sending = false;
    const send = async () => {
      const text = input.value;
      const files = [...(this.#staged.get(room.id) ?? [])];
      const editing = this.#editing;
      if ((!text.trim() && !(files.length && !editing)) || sending) return;
      if (files.length && !editing && !room.fileTransfer) return ui.notify(t('filesOff'));
      sending = true;
      sendButton.disabled = true;
      input.value = '';
      fit();
      try {
        if (editing) { // the staged files wait: an edit changes one message, nothing else
          await room.editMessage(editing.id, text);
          this.#editing = null;
          drawQuote();
        } else {
          for (const file of files) { // nothing leaves the message box before this point
            await room.shareFile(file);
            this.remove(room, file);
          }
          if (text.trim()) await room.sendText(text, this.#quote);
          this.setQuote(null);
        }
        drawLog(true);
      } catch (err) {
        input.value = text;
        fit();
        ui.notify(err.message);
      } finally {
        sending = false;
        sendButton.disabled = false;
      }
    };
    input.addEventListener('keydown', (e) => {
      // IME-safe
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        send();
      } else if (e.key === 'Escape' && this.#editing) this.cancelEdit();
    });

    let depth = 0; // dragenter/dragleave also fire for every child element
    const { stage } = ui;
    const stopDrop = () => { depth = 0; stage.classList.remove('dropping'); };
    stopDrop();
    stage.dataset.drop = t('dropHere');
    stage.ondragenter = (e) => {
      if (dragHasFiles(e)) { depth++; stage.classList.add('dropping'); }
    };
    stage.ondragleave = (e) => { if (dragHasFiles(e) && --depth <= 0) stopDrop(); };
    stage.ondragover = (e) => { if (dragHasFiles(e)) e.preventDefault(); };
    stage.ondrop = (e) => {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      stopDrop();
      const { files, folders } = droppedFiles(e.dataTransfer);
      this.add(room, files, folders);
    };

    if (room.removed) {
      input.disabled = true;
      input.placeholder = t('removedBanner');
      sendButton.disabled = true;
    }
    const attach = h('button', {
      class: 'ghost',
      title: t('attach'),
      'aria-label': t('attach'),
      onclick: () => (room.fileTransfer ? picker.click() : ui.notify(t('filesOff'))),
    }, '+');
    return {
      quoteBar, chips, draw: () => this.#drawStaged(),
      bar: h('div', { class: 'composer' }, input, picker, attach, sendButton),
    };
  }

  setQuote(env) {
    if (env && this.#editing) this.cancelEdit();
    this.#quote = env;
    this.#drawQuote();
    if (env) this.#input?.focus();
  }

  /** Put one of our messages into the message box; sending then replaces its text. */
  startEdit(room, env) {
    this.#quote = null;
    this.#editing = env;
    this.#input.value = room.log.textOf(env);
    this.#fitInput();
    this.#drawQuote();
    this.#input.focus();
  }

  cancelEdit() {
    this.#editing = null;
    this.#input.value = '';
    this.#fitInput();
    this.#drawQuote();
  }

  /** Put files into the message box (picker, paste, drop). They are only sent, to everyone
   *  in the room, when the user presses Enter or Send. */
  add(room, files, folders = 0) {
    if (!room.fileTransfer) return this.ui.notify(t('filesOff')); // paused for a call
    if (folders) this.ui.notify(t('noFolders'));
    const { list, tooBig, tooMany } = stageFiles(
      this.#staged.get(room.id) ?? [], files, { maxBytes: room.settings.maxFileBytes },
    );
    if (tooBig.length) {
      const [file] = tooBig;
      const max = fmtSize(room.settings.maxFileBytes);
      this.ui.notify(t('fileTooBig', { name: file.name, max }));
    } else if (tooMany) this.ui.notify(t('tooManyFiles', { n: MAX_AT_ONCE }));
    this.#staged.set(room.id, list);
    if (room === this.ui.current) { this.#drawStaged(); this.#input?.focus(); }
  }

  remove(room, file) {
    this.#staged.set(room.id, (this.#staged.get(room.id) ?? []).filter((f) => f !== file));
    const url = this.#chipUrls.get(file);
    if (url) URL.revokeObjectURL(url);
    this.#chipUrls.delete(file);
    if (room === this.ui.current) this.#drawStaged();
  }

  #chip(room, file) {
    const small = file.type.startsWith('image/') && file.size <= 15 * 1024 * 1024;
    if (small && !this.#chipUrls.has(file)) this.#chipUrls.set(file, URL.createObjectURL(file));
    return h('div', { class: 'chip' },
      small ? h('img', { class: 'chip-img', alt: '', src: this.#chipUrls.get(file) })
        : h('span', { class: 'chip-blank' }),
      h('span', { class: 'chip-name', title: file.name }, file.name),
      h('span', { class: 'file-size' }, fmtSize(file.size)),
      h('button', {
        class: 'ghost', title: t('removeAttachment'), 'aria-label': t('removeAttachment'),
        onclick: () => this.remove(room, file),
      }, '×'));
  }

  /** Ctrl/Cmd+V: files on the clipboard are staged; text pastes as usual. */
  onPaste(event) {
    const room = this.ui.current;
    const files = clipboardFiles(event.clipboardData);
    if (!room || !files.length || this.ui.dialog.open) return;
    const field = event.target.closest?.('input, textarea');
    if (field && !field.closest('.composer')) return; // other fields keep their own paste
    event.preventDefault();
    this.add(room, files);
  }
}
