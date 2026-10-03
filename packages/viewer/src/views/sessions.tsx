import { appStore } from '../state'
import { SessionInfo, SessionNameField } from '../session-name'
import { useStore } from '../store'

function formatTime(timestamp: number): string {
  return new Date(timestamp).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

/**
 * The session list: open (click the row or Open), rename (click the name, edit in place), end.
 */
export function SessionsView({
  hostname,
  onOpen,
  onEnd,
  onNewSession,
  onSignOut,
}: {
  hostname: string
  onOpen: (session: SessionInfo) => void
  onEnd: (session: SessionInfo) => void
  onNewSession: () => void
  onSignOut: () => void
}) {
  const view = useStore(appStore)
  const sessions = [...view.sessions].sort((a, b) => a.createdAt - b.createdAt)
  return (
    <div id="sessions-view" className="page" hidden={view.view !== 'sessions'}>
      <main className="card wide">
        <h1 id="welcome">Welcome, {view.username}</h1>
        <p className="subtitle" id="sessions-hostname">
          {hostname}
        </p>
        <p className="error" role="alert" id="sessions-error" hidden={view.sessionsError === undefined}>
          {view.sessionsError}
        </p>
        <ul className="sessions" id="session-list" hidden={sessions.length === 0}>
          {sessions.map((session) => (
            <SessionRow key={session.id} session={session} onOpen={onOpen} onEnd={onEnd} />
          ))}
        </ul>
        <p className="empty" id="no-sessions" hidden={sessions.length !== 0}>
          You have no running sessions.
        </p>
        <div className="row">
          <button className="link-button" type="button" id="sign-out" onClick={onSignOut}>
            Sign out
          </button>
          <button
            className="primary"
            type="button"
            id="new-session"
            disabled={view.creatingSession}
            onClick={onNewSession}
          >
            Start new session
          </button>
        </div>
      </main>
    </div>
  )
}

function SessionRow({
  session,
  onOpen,
  onEnd,
}: {
  session: SessionInfo
  onOpen: (session: SessionInfo) => void
  onEnd: (session: SessionInfo) => void
}) {
  const setError = (message: string | undefined) => appStore.update({ sessionsError: message })
  return (
    // anywhere on the row except the name field and the End button opens the session
    <li
      data-session={session.id}
      onClick={(event) => {
        if (!(event.target instanceof Element && event.target.closest('label.session-name'))) {
          onOpen(session)
        }
      }}
    >
      <div className="name">
        <SessionNameField
          key={session.name}
          session={session}
          showError={setError}
          onRenamed={(renamed) =>
            appStore.update({
              sessions: appStore.get().sessions.map((s) => (s.id === renamed.id ? renamed : s)),
            })
          }
        />
        <span className="when">Started {formatTime(session.createdAt)}</span>
      </div>
      <button type="button" className="primary" data-action="open">
        Open
      </button>
      <button
        type="button"
        data-action="end"
        onClick={(event) => {
          event.stopPropagation()
          onEnd(session)
        }}
      >
        End
      </button>
    </li>
  )
}
