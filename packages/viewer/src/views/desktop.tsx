import { RefObject } from 'react'
import { Core, CoreContext } from '../core'
import { appStore } from '../state'
import { useStore } from '../store'
import { AppsMenu, AppsMenuActions } from '../shell/apps-menu'
import { Taskbar } from '../shell/taskbar'
import { PopupLayer } from '../shell/popup-layer'
import { NotificationsPanel, Toasts } from '../shell/notifications'

/**
 * The desktop: the taskbar at the top, the session output below it (the output of the remote compositor, see
 * desktop.ts) and the reconnect overlay. The core (connection, window manager, shell controller) is
 * mounted once behind the output ref (see app.tsx) and provided to the shell components through its context.
 */
export function DesktopView({
  core,
  outputRef,
  appsMenuActions,
  onReconnect,
  onRestart,
}: {
  core: Core | null
  outputRef: RefObject<HTMLDivElement>
  appsMenuActions: AppsMenuActions
  onReconnect: () => void
  onRestart: () => void
}) {
  const view = useStore(appStore)
  const connection = view.connection
  // the overlay covers the output whenever the session is unreachable; reconnecting shows its own message
  const overlayHidden =
    connection.kind === 'connected' || connection.kind === 'connecting' || connection.kind === 'signed-out'
  const overlayMessage =
    connection.kind === 'reconnecting'
      ? `Connection lost. Reconnecting in ${connection.inSeconds}s…`
      : connection.kind === 'taken-over'
        ? 'This desktop was opened somewhere else.'
        : connection.kind === 'ended'
          ? 'This desktop has ended.'
          : ''
  return (
    <CoreContext.Provider value={core}>
      <div id="desktop-view" hidden={view.view !== 'desktop'}>
        {/* the taskbar is empty until the core is mounted (the very first render only) */}
        {core === null ? <header id="taskbar" /> : <Taskbar />}
        {/* the output is always there: the core is mounted behind it (app.tsx). Its content (the window elements) belongs to desktop.ts, not to React. */}
        <main id="output-container">
          <div id="output" tabIndex={0} ref={outputRef} />
          <div id="overlay" hidden={overlayHidden}>
            <div id="overlay-message">{overlayMessage}</div>
            {connection.kind === 'taken-over' && (
              <button type="button" id="overlay-reconnect" onClick={onReconnect}>
                Reconnect
              </button>
            )}
            {connection.kind === 'ended' && (
              <button type="button" id="overlay-restart" onClick={onRestart}>
                Start a new desktop
              </button>
            )}
          </div>
        </main>
        {core !== null && (
          <>
            <PopupLayer />
            {/* these two stay in the document, hidden when closed (tests check their hidden flag) */}
            <AppsMenu actions={appsMenuActions} />
            <NotificationsPanel />
            <Toasts />
          </>
        )}
      </div>
    </CoreContext.Provider>
  )
}
