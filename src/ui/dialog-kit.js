// The one <dialog> of the page and what goes into it: the frame with a close button, a
// read-only field with a Copy button, a QR code, and a box for a pasted or scanned code.
import { encodeQr, qrPath } from '../qr/qr.js';
import { h, qrSvg } from './dom.js';
import { t } from './i18n.js';
import { canScan, scanQr } from './scanner.js';

export class DialogKit {
  #stopScan = null; // stops the camera when the dialog closes

  constructor(dialog) {
    this.dialog = dialog;
    dialog.onclose = () => this.#stopScan?.();
  }

  open(title, ...content) {
    this.dialog.classList.remove('wide');
    this.dialog.replaceChildren(
      h(
        'header',
        {},
        h('h2', {}, title),
        h('button', { class: 'ghost', onclick: () => this.dialog.close() }, t('close')),
      ),
      ...content.filter((part) => part != null && part !== false)); // never print "null"
    if (!this.dialog.open) this.dialog.showModal();
  }

  /** Read-only field with a Copy button. */
  copyField(value, rows = 1) {
    const field = h(
      'textarea',
      { class: 'code', readOnly: true, rows, value, onfocus: () => field.select() },
    );
    const button = h('button', {
      onclick: async () => {
        try { await navigator.clipboard.writeText(value); } catch {
          field.select();
          document.execCommand('copy');
        }
        button.textContent = t('copied');
        setTimeout(() => { button.textContent = t('copy'); }, 1500);
      },
    }, t('copy'));
    return h('div', { class: 'copy-field' }, field, button);
  }

  qr(text) {
    try {
      const qr = encodeQr(text, 'L');
      return qrSvg(qrPath(qr, 4), qr.size, t('scan'));
    } catch { return null; }
  }

  /** Textarea + optional camera scanner; onText receives pasted or scanned text. */
  codeInput(placeholder, onText) {
    const area = h('textarea', { class: 'code', rows: 3, placeholder });
    const view = h('div', { hidden: true }); // holds the camera picture, only while scanning
    const scan = canScan() && h('button', {
      onclick: () => {
        const video = h('video', { class: 'scan', playsInline: true, muted: true });
        view.replaceChildren(video);
        view.hidden = false;
        this.#stopScan = scanQr(video, (text) => {
          view.hidden = true;
          view.replaceChildren();
          if (text) { area.value = text; onText(text); }
        });
      },
    }, t('scan'));
    const submit = () => area.value.trim() && onText(area.value);
    area.addEventListener('paste', () => { // a pasted code replaces what was there
      area.value = '';
      setTimeout(submit, 0);
    });
    // A camera but no QR detector (Firefox): say why there is no scan button.
    const noScan = !canScan() && !!navigator.mediaDevices?.getUserMedia
      && h('p', { class: 'muted' }, t('scanUnavailable'));
    return { area, submit, node: h('div', { class: 'code-input' }, area, view, scan, noScan) };
  }
}
