/**
 * Files dragged from the user's computer onto the desktop and dropped on a remote app (see the scene protocol's
 * `file-drag` and `file-drop`, native/wlr-core/src/wlr_core_dnd.c).
 *
 * While the files are over the page, the core runs a drag of ours that offers `text/uri-list`: apps under the pointer
 * show their drop targets. At the drop the content arrives (FILE chunks); the files are saved in a directory of the
 * user's, `<cache>/greenfield/drops/<random>/<name>` (the cache is $XDG_CACHE_HOME or ~/.cache; each drop gets a
 * directory of its own, so names can't collide with an earlier drop's; directories older than a day are removed when a
 * session starts), and once they're all there the app gets their `file://` URIs. The app's request for the data waits
 * for that (the core keeps its pipe), so a big upload delays the app's paste of the drop, not the session.
 */
import { promises as fs, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createLogger } from '../Logger.js'
import type { ControlMessage } from '../viewer/ViewerTransport.js'

const logger = createLogger('file-drops')

/** What the core offers for drags of files. */
export interface FileDragNative {
  startFileDrag(sid: number): boolean
  fileDragAccepted(): boolean
  dropFileDrag(timeMs: number): void
  cancelFileDrag(): void
  provideFiles(list: string): void
}

/** The most one drop may upload, and how many files it may have. */
export const MAX_DROP_BYTES = 2 * 1024 * 1024 * 1024
export const MAX_DROP_FILES = 1000
/** How long a drop waits for the app under the pointer to accept the files (it answers the drag's enter). */
const ACCEPT_TIMEOUT_MS = 500
const ACCEPT_POLL_MS = 20
const KEEP_MS = 24 * 60 * 60 * 1000

type Upload = {
  path: string
  size: number
  received: number
  /** writes in order */
  chain: Promise<void>
  failed: boolean
  done: boolean
  drop: Drop
}

type Drop = { uploads: Upload[]; announced: boolean; provided: boolean }

export function defaultDropsDirectory(): string {
  return path.join(process.env.XDG_CACHE_HOME || path.join(homedir(), '.cache'), 'greenfield', 'drops')
}

/** A name that's safe to create in the drop's directory: no path, no control characters, not empty. */
export function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  let safe = name.replace(/[/\\\u0000-\u001f\u007f]/g, '_').trim()
  if (safe === '' || safe === '.' || safe === '..') {
    safe = 'file'
  }
  // 255 bytes is the usual limit of a name; keep the extension's end
  while (Buffer.byteLength(safe) > 200) {
    safe = safe.slice(1)
  }
  return safe
}

export class FileDrops {
  /** the core's file drag is going on */
  private active = false
  private readonly uploads = new Map<number, Upload>()

  constructor(
    private readonly native: FileDragNative,
    /** pointer motion to this target (what moves the drag's pointer) */
    private readonly motion: (target: ControlMessage) => void,
    private readonly sidOf: (surface: unknown) => number | undefined,
    private readonly directory = defaultDropsDirectory(),
    private readonly acceptTimeout = ACCEPT_TIMEOUT_MS,
  ) {
    void this.removeOld()
  }

  /** Files are over the desktop, at this target. */
  over(target: ControlMessage): void {
    if (!this.start(target)) {
      return
    }
    this.motion(target)
  }

  /** The files left the page. */
  leave(): void {
    if (this.active) {
      this.active = false
      this.native.cancelFileDrag()
    }
  }

  /** The files are dropped at this target; their content follows. */
  drop(target: ControlMessage): void {
    const files = parseFiles(target.files)
    if (files === undefined || files.length === 0 || !this.start(target)) {
      this.leave()
      return
    }
    this.motion(target)
    const drop: Drop = { uploads: [], announced: false, provided: false }
    let directory: string
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      directory = path.join(this.directory, `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
      mkdirSync(directory, { mode: 0o700 })
    } catch (e: any) {
      logger.error(`Can't create the directory for dropped files: ${e.message}`)
      this.leave()
      return
    }
    const names = new Set<string>()
    for (const file of files) {
      let name = safeFileName(file.name)
      for (let n = 2; names.has(name); n++) {
        name = `${safeFileName(file.name)} (${n})`
      }
      names.add(name)
      const upload: Upload = {
        path: path.join(directory, name),
        size: file.size,
        received: 0,
        chain: fs.writeFile(path.join(directory, name), '', { mode: 0o600 }),
        failed: false,
        done: file.size === 0,
        drop,
      }
      upload.chain.catch((e) => this.failed(upload, e))
      drop.uploads.push(upload)
      this.uploads.set(file.id, upload)
    }
    drop.announced = true
    void this.release(Number(target.time) >>> 0, drop)
  }

  /** The next bytes of a file. */
  chunk(id: number, data: Uint8Array): void {
    const upload = this.uploads.get(id)
    if (upload === undefined || upload.done || upload.failed) {
      return
    }
    // (never more than announced)
    const bytes = data.subarray(0, Math.max(0, upload.size - upload.received))
    upload.received += bytes.length
    const copy = Buffer.from(bytes)
    upload.chain = upload.chain
      .then(() => fs.appendFile(upload.path, copy))
      .catch((e) => this.failed(upload, e))
    if (upload.received >= upload.size) {
      upload.done = true
      void upload.chain.then(() => this.checkComplete(upload.drop))
    }
  }

  private failed(upload: Upload, error: Error) {
    if (!upload.failed) {
      logger.error(`Can't save a dropped file: ${error.message}`)
    }
    upload.failed = true
  }

  /** Starts the core's drag if it isn't going on. False if there's nothing to drop on. */
  private start(target: ControlMessage): boolean {
    if (this.active) {
      return true
    }
    const sid = this.sidOf(target.surface)
    if (sid === undefined || !this.native.startFileDrag(sid)) {
      return false
    }
    this.active = true
    return true
  }

  /** Lets go of the drag once the app has accepted it; then, when everything's there, tells it where the files are. */
  private async release(time: number, drop: Drop) {
    const deadline = Date.now() + this.acceptTimeout
    while (this.active && !this.native.fileDragAccepted() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, ACCEPT_POLL_MS))
    }
    if (!this.active) {
      return
    }
    this.active = false
    if (this.native.fileDragAccepted()) {
      this.native.dropFileDrag(time)
    } else {
      // nobody takes them
      this.native.cancelFileDrag()
      return
    }
    void this.checkComplete(drop)
  }

  private async checkComplete(drop: Drop) {
    if (drop.provided || !drop.announced || !drop.uploads.every((upload) => upload.done || upload.failed)) {
      return
    }
    drop.provided = true
    await Promise.all(drop.uploads.map((upload) => upload.chain))
    // (the drop may complete before the app accepts, or before it's released: the core keeps the list for the app)
    const list = drop.uploads
      .filter((upload) => !upload.failed)
      .map((upload) => pathToFileURL(upload.path).href + '\r\n')
      .join('')
    for (const [id, upload] of this.uploads) {
      if (upload.drop === drop) {
        this.uploads.delete(id)
      }
    }
    this.native.provideFiles(list)
  }

  /** Directories of earlier drops, older than a day. */
  private async removeOld() {
    try {
      for (const entry of await fs.readdir(this.directory)) {
        const entryPath = path.join(this.directory, entry)
        const { mtimeMs } = await fs.stat(entryPath)
        if (Date.now() - mtimeMs > KEEP_MS) {
          await fs.rm(entryPath, { recursive: true, force: true })
        }
      }
    } catch {
      // there's no directory yet, or it's not ours to clean
    }
  }
}

/** The announced files, undefined if the message isn't acceptable. */
function parseFiles(value: unknown): { id: number; name: string; size: number }[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_DROP_FILES) {
    return undefined
  }
  let total = 0
  const files: { id: number; name: string; size: number }[] = []
  for (const file of value) {
    if (
      typeof file !== 'object' ||
      file === null ||
      !Number.isSafeInteger(file.id) ||
      typeof file.name !== 'string' ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0
    ) {
      return undefined
    }
    total += file.size
    files.push({ id: file.id, name: file.name, size: file.size })
  }
  return total <= MAX_DROP_BYTES ? files : undefined
}
