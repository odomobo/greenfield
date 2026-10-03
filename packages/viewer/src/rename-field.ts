import { api } from './auth'

export type SessionInfo = { id: string; name: string; createdAt: number }

export const MAX_SESSION_NAME_LENGTH = 64

const pencilIcon =
  '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16.9 3.1a3 3 0 0 1 4.2 4.2L8.6 19.8l-5.1 1.1 1.1-5.1L16.9 3.1Zm-1.1 3.3-9.4 9.4-.5 2.2 2.2-.5 9.4-9.4-1.7-1.7Z"/></svg>'

/**
 * A session name that is edited in place: looks like a title until hovered or focused, then shows a field outline
 * and a pencil (styles: .session-name in theme.css). Enter or leaving the field saves, Escape cancels. Used by the
 * session list and the Apps menu.
 */
export function sessionNameField(
  session: SessionInfo,
  showError: (message: string | undefined) => void,
  onRenamed: (session: SessionInfo) => void = () => {
    /* noop */
  },
): { field: HTMLLabelElement; input: HTMLInputElement } {
  const field = document.createElement('label')
  field.className = 'session-name'
  field.title = 'Rename'
  const input = document.createElement('input')
  input.type = 'text'
  input.value = session.name
  input.maxLength = MAX_SESSION_NAME_LENGTH
  input.spellcheck = false
  input.autocomplete = 'off'
  input.setAttribute('aria-label', 'Rename session')
  field.append(input)
  field.insertAdjacentHTML('beforeend', pencilIcon)

  let saved = session.name
  let cancelled = false
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      input.blur()
    } else if (event.key === 'Escape') {
      cancelled = true
      input.value = saved
      input.blur()
    }
  })
  input.addEventListener('blur', async () => {
    if (cancelled) {
      cancelled = false
      return
    }
    const name = input.value
    if (name === saved) {
      return
    }
    const response = await api(`/api/sessions/${encodeURIComponent(session.id)}/rename`, {
      method: 'POST',
      body: { name },
    })
    if (response.ok) {
      const renamed: SessionInfo = await response.json()
      saved = renamed.name
      input.value = saved
      showError(undefined)
      onRenamed(renamed)
    } else {
      input.value = saved
      showError(
        response.status === 400
          ? `A session name must be 1 to ${MAX_SESSION_NAME_LENGTH} characters long.`
          : 'The session could not be renamed.',
      )
    }
  })
  return { field, input }
}
