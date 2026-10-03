import { api } from './auth'

export type SessionInfo = { id: string; name: string; createdAt: number }

const MAX_NAME_LENGTH = 64

const pencilIcon =
  '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16.9 3.1a3 3 0 0 1 4.2 4.2L8.6 19.8l-5.1 1.1 1.1-5.1L16.9 3.1Zm-1.1 3.3-9.4 9.4-.5 2.2 2.2-.5 9.4-9.4-1.7-1.7Z"/></svg>'

function formatTime(timestamp: number): string {
  return new Date(timestamp).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

/**
 * The session list: open (click the row or Open), rename (click the name, edit in place), end.
 */
export class SessionList {
  constructor(
    private readonly list: HTMLUListElement,
    private readonly empty: HTMLElement,
    private readonly showError: (message: string | undefined) => void,
    private readonly open: (session: SessionInfo) => void,
    private readonly end: (session: SessionInfo) => void,
  ) {}

  render(sessions: SessionInfo[]): void {
    this.list.replaceChildren(...[...sessions].sort((a, b) => a.createdAt - b.createdAt).map((s) => this.row(s)))
    this.list.hidden = sessions.length === 0
    this.empty.hidden = sessions.length !== 0
  }

  private row(session: SessionInfo): HTMLLIElement {
    const row = document.createElement('li')
    row.dataset.session = session.id

    const name = document.createElement('div')
    name.className = 'name'
    const field = document.createElement('label')
    field.className = 'session-name'
    field.title = 'Rename'
    const input = document.createElement('input')
    input.type = 'text'
    input.value = session.name
    input.maxLength = MAX_NAME_LENGTH
    input.spellcheck = false
    input.autocomplete = 'off'
    input.setAttribute('aria-label', 'Rename session')
    field.append(input)
    field.insertAdjacentHTML('beforeend', pencilIcon)
    const when = document.createElement('span')
    when.className = 'when'
    when.textContent = `Started ${formatTime(session.createdAt)}`
    name.append(field, when)
    this.makeRenamable(input, session)

    const openButton = document.createElement('button')
    openButton.type = 'button'
    openButton.className = 'primary'
    openButton.textContent = 'Open'
    openButton.dataset.action = 'open'

    const endButton = document.createElement('button')
    endButton.type = 'button'
    endButton.textContent = 'End'
    endButton.dataset.action = 'end'
    endButton.addEventListener('click', (event) => {
      event.stopPropagation()
      this.end(session)
    })

    row.append(name, openButton, endButton)
    // anywhere on the row except the name field and the End button opens the session
    row.addEventListener('click', (event) => {
      if (!field.contains(event.target as Node)) {
        this.open(session)
      }
    })
    return row
  }

  private makeRenamable(input: HTMLInputElement, session: SessionInfo) {
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
        this.showError(undefined)
      } else {
        input.value = saved
        this.showError(
          response.status === 400
            ? `A session name must be 1 to ${MAX_NAME_LENGTH} characters long.`
            : 'The session could not be renamed.',
        )
      }
    })
  }
}
