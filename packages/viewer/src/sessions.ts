import { SessionInfo, sessionNameField } from './rename-field'

export type { SessionInfo }

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
    const { field } = sessionNameField(session, this.showError)
    const when = document.createElement('span')
    when.className = 'when'
    when.textContent = `Started ${formatTime(session.createdAt)}`
    name.append(field, when)

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
}
