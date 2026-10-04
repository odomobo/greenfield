/**
 * Files dragged from the user's computer onto the desktop (the protocol's `file-drag` and `file-drop`): which of the
 * dropped items are files, and uploading them in chunks that wait for the socket (a big file must not pile up in
 * the browser's memory).
 */

/** Uploads never ask for more than this in one message, and wait while this much is waiting to be sent. */
export const CHUNK_BYTES = 256 * 1024
const MAX_BUFFERED_BYTES = 1024 * 1024
const BUFFER_POLL_MS = 10
/** The server refuses drops bigger than this (scene protocol). */
export const MAX_DROP_BYTES = 2 * 1024 * 1024 * 1024
export const MAX_DROP_FILES = 1000

/** The part of a DataTransfer used here. */
export type DroppedItems = {
  types: readonly string[]
  items?: ArrayLike<{
    kind: string
    getAsFile(): File | null
    webkitGetAsEntry?(): { isDirectory: boolean } | null
  }>
  files?: ArrayLike<File>
}

/** True if a drag carries files (the browser doesn't tell more until the drop). */
export function dragHasFiles(data: Pick<DroppedItems, 'types'> | null | undefined): boolean {
  return data !== null && data !== undefined && Array.from(data.types).includes('Files')
}

/**
 * The files of a drop. Folders are left out (their content isn't a file; the browser lists them like one). Must be
 * called while handling the drop event: the browser empties the data afterwards.
 */
export function droppedFiles(data: DroppedItems): File[] {
  const files: File[] = []
  if (data.items && data.items.length > 0) {
    for (let i = 0; i < data.items.length; i++) {
      const item = data.items[i]
      if (item.kind !== 'file' || item.webkitGetAsEntry?.()?.isDirectory) {
        continue
      }
      const file = item.getAsFile()
      if (file) {
        files.push(file)
      }
    }
    return files
  }
  return Array.from(data.files ?? [])
}

/** Whether the server would take these files. */
export function dropAllowed(files: Pick<File, 'size'>[]): boolean {
  return (
    files.length > 0 && files.length <= MAX_DROP_FILES && files.reduce((sum, f) => sum + f.size, 0) <= MAX_DROP_BYTES
  )
}

/** Where uploads go. */
export type UploadSink = {
  chunk(id: number, bytes: Uint8Array): void
  /** bytes waiting to be sent */
  buffered(): number
}

/** Uploads the files one after the other, each in chunks, waiting while the socket has a backlog. */
export async function uploadFiles(files: { id: number; file: Blob }[], sink: UploadSink): Promise<void> {
  for (const { id, file } of files) {
    for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
      while (sink.buffered() > MAX_BUFFERED_BYTES) {
        await new Promise((resolve) => setTimeout(resolve, BUFFER_POLL_MS))
      }
      const bytes = new Uint8Array(await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer())
      sink.chunk(id, bytes)
    }
  }
}
