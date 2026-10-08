/**
 * The clipboard between the remote apps and the viewer's browser (text only, see
 * native/wlr-core/src/wlr_core_clipboard.c).
 *
 * An app's selection arrives as clipboard-text and goes to the viewer; the browser's text arrives from the viewer
 * (when the user pastes) and becomes the session's selection. The last text either way is remembered, so the same text
 * isn't set twice, and the selection we set ourselves is never reported back by the core.
 */
import type { ControlMessage } from '../viewer/ViewerTransport.js'

/** The most text (UTF-16 units; a UTF-8 byte is never fewer) taken from the browser. The core caps apps' selections. */
export const MAX_CLIPBOARD_CHARS = 4 * 1024 * 1024

export class Clipboard {
  private send?: (message: ControlMessage) => void
  /** the text of the session's current text selection, as far as we know */
  private text: string | undefined

  constructor(private readonly setSelection: (text: string) => void) {}

  attach(send: (message: ControlMessage) => void): void {
    this.send = send
  }

  detach(): void {
    this.send = undefined
  }

  /** An app set the selection. */
  remoteText(text: string): void {
    this.text = text
    this.send?.({ type: 'clipboard', text })
  }

  /** The viewer's clipboard text, from a paste. */
  viewerText(text: unknown): void {
    if (typeof text !== 'string' || text.length > MAX_CLIPBOARD_CHARS || text === this.text) {
      return
    }
    this.text = text
    this.setSelection(text)
  }
}
