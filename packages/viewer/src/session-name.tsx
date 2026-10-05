import { useEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { api } from './auth'

export type SessionInfo = { id: string; name: string; createdAt: number }

export const MAX_SESSION_NAME_LENGTH = 64

type SessionNameFieldProps = {
  session: SessionInfo
  showError: (message: string | undefined) => void
  onRenamed?: (session: SessionInfo) => void
  /** id for the field element (e.g. #apps-session-name) */
  id?: string
}

/**
 * A session name that is edited in place: looks like a title until hovered or focused, then shows a field outline
 * and a pencil (styles: .session-name in theme.css). Enter or leaving the field saves, Escape cancels. Used by the
 * session list and the Apps menu. Remount it (key it by the name) when the name changed elsewhere.
 */
export function SessionNameField({ session, showError, onRenamed, id }: SessionNameFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const saved = useRef(session.name)
  const cancelled = useRef(false)
  const labelRef = useRef<HTMLLabelElement>(null)

  // the label carries the text being shown, for the styles that size the field to it (the Apps menu's centered name).
  // An element-level listener: React's delegated onInput misses input events dispatched on the element itself.
  const sync = () => {
    if (labelRef.current !== null && inputRef.current !== null) {
      labelRef.current.dataset.value = inputRef.current.value
    }
  }
  useEffect(() => {
    const input = inputRef.current
    input?.addEventListener('input', sync)
    return () => input?.removeEventListener('input', sync)
  }, [])

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      inputRef.current?.blur()
    } else if (event.key === 'Escape') {
      cancelled.current = true
      if (inputRef.current) {
        inputRef.current.value = saved.current
        sync()
      }
      inputRef.current?.blur()
    }
  }

  const onBlur = async () => {
    const input = inputRef.current
    if (input === null) {
      return
    }
    if (cancelled.current) {
      cancelled.current = false
      return
    }
    const name = input.value
    if (name === saved.current) {
      return
    }
    const response = await api(`/api/sessions/${encodeURIComponent(session.id)}/rename`, {
      method: 'POST',
      body: { name },
    })
    if (response.ok) {
      const renamed: SessionInfo = await response.json()
      saved.current = renamed.name
      input.value = saved.current
      sync()
      showError(undefined)
      onRenamed?.(renamed)
    } else {
      input.value = saved.current
      sync()
      showError(
        response.status === 400
          ? `A session name must be 1 to ${MAX_SESSION_NAME_LENGTH} characters long.`
          : 'The session could not be renamed.',
      )
    }
  }

  return (
    <label className="session-name" title="Rename" id={id} ref={labelRef} data-value={session.name}>
      <input
        ref={inputRef}
        type="text"
        defaultValue={session.name}
        maxLength={MAX_SESSION_NAME_LENGTH}
        spellCheck={false}
        autoComplete="off"
        aria-label="Rename session"
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      />
      <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="currentColor"
          d="M16.9 3.1a3 3 0 0 1 4.2 4.2L8.6 19.8l-5.1 1.1 1.1-5.1L16.9 3.1Zm-1.1 3.3-9.4 9.4-.5 2.2 2.2-.5 9.4-9.4-1.7-1.7Z"
        />
      </svg>
    </label>
  )
}
