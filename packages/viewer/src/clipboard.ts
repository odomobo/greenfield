/**
 * The viewer's side of the clipboard (text only). Remote apps' text is written to the browser's clipboard; the
 * browser's text is sent to the server when the user pastes, before the paste's key events, so the app finds it as the
 * selection when it handles the paste.
 *
 * Browsers are strict: writing needs the page to have focus (and often a user gesture), reading needs the user's
 * permission and focus. A write that fails is kept and retried at the next user input and when the page gets focus.
 */

/** The part of navigator.clipboard used here (it's missing in insecure contexts and old browsers). */
export interface ClipboardApi {
  readText?(): Promise<string>
  writeText?(text: string): Promise<void>
}

/** How long a paste waits for the browser to hand over its clipboard (e.g. while it asks the user for permission). */
const READ_TIMEOUT_MS = 1500
/** The paste event fallback (browsers without readText) fires right after the key press. */
const PASTE_EVENT_TIMEOUT_MS = 300
/** Same cap as the server's: bigger text isn't synchronized. */
const MAX_TEXT_CHARS = 4 * 1024 * 1024

type KeyChord = { code: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }

/** Ctrl+V (also Ctrl+Shift+V, which terminals paste with) and Shift+Insert: the keys that paste on Linux. */
export function isPasteChord(event: KeyChord): boolean {
  if (event.altKey || event.metaKey) {
    return false
  }
  return (event.code === 'KeyV' && event.ctrlKey) || (event.code === 'Insert' && event.shiftKey && !event.ctrlKey)
}

export class ClipboardSync {
  /** the text the browser's clipboard and the session are known to share, last */
  private synced: string | undefined
  /** an app's text that couldn't be written to the browser's clipboard yet */
  private pending: string | undefined
  private pasteEvent?: (text: string | undefined) => void

  constructor(
    private readonly api: ClipboardApi | undefined,
    private readonly send: (text: string) => void,
  ) {}

  /** Whether the clipboard can be read on demand; without it the paste event is the only way (see beforePaste). */
  get canRead(): boolean {
    return typeof this.api?.readText === 'function'
  }

  /** An app set the clipboard. */
  remoteText(text: string): void {
    this.pending = text
    void this.flush()
  }

  /** The user did something (a key, a click) or the page got focus: browsers allow a pending write now. */
  retryPending(): Promise<void> {
    return this.pending === undefined ? Promise.resolve() : this.flush()
  }

  private async flush(): Promise<void> {
    const text = this.pending
    if (text === undefined || typeof this.api?.writeText !== 'function') {
      return
    }
    try {
      await this.api.writeText(text)
      if (this.pending === text) {
        this.pending = undefined
        this.synced = text
      }
    } catch {
      // not allowed now (no focus, no gesture): stays pending
    }
  }

  /** Text from a paste event (and, below, from readText): sent if the session doesn't have it already. */
  private viewerText(text: string | undefined): void {
    if (text === undefined || text === '' || text.length > MAX_TEXT_CHARS || text === this.synced) {
      return
    }
    this.synced = text
    this.send(text)
  }

  /**
   * The user pressed a paste chord: resolves once the browser's clipboard text has been sent (if it's news to the
   * session), or it isn't available; the key events go after that. A waiting app text (one the browser wouldn't take
   * yet) is written first instead, since the user's key press is the gesture that allows it: that's what the user
   * last copied.
   */
  async beforePaste(): Promise<void> {
    if (this.pending !== undefined) {
      await this.flush()
      if (this.pending === undefined) {
        return
      }
    }
    if (this.canRead) {
      try {
        const text = await withTimeout(this.api!.readText!(), READ_TIMEOUT_MS)
        this.viewerText(text)
      } catch {
        // no permission, no focus: the paste goes ahead with what the app has
      }
      return
    }
    // no readText: the key press's default action fires a paste event, which the page forwards to pasteEvent()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.pasteEvent = undefined
        resolve()
      }, PASTE_EVENT_TIMEOUT_MS)
      this.pasteEvent = (text) => {
        clearTimeout(timer)
        this.pasteEvent = undefined
        this.viewerText(text)
        resolve()
      }
    })
  }

  /** A paste event reached the page (a paste chord's default action, or Paste from the browser's menu). */
  onPasteEvent(text: string | undefined): void {
    if (this.pasteEvent) {
      this.pasteEvent(text)
    } else {
      this.viewerText(text)
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
