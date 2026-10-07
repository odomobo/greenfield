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
 * desktop.ts). Losing the connection shows the sign-in form instead (app.tsx). The core (connection, window manager, shell controller) is
 * mounted once behind the output ref (see app.tsx) and provided to the shell components through its context.
 */
export function DesktopView({
  core,
  outputRef,
  appsMenuActions,
}: {
  core: Core | null
  outputRef: RefObject<HTMLDivElement>
  appsMenuActions: AppsMenuActions
}) {
  const view = useStore(appStore)
  return (
    <CoreContext.Provider value={core}>
      <div id="desktop-view" hidden={view.view !== 'desktop'}>
        {/* the taskbar is empty until the core is mounted (the very first render only) */}
        {core === null ? <header id="taskbar" /> : <Taskbar />}
        {/* the output is always there: the core is mounted behind it (app.tsx). Its content (the window elements) belongs to desktop.ts, not to React. */}
        <main id="output-container">
          <div id="output" tabIndex={0} ref={outputRef} />
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
