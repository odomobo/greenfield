import { useEffect, useRef, useState } from 'react'
import { useCore } from '../core'
import { audioStore, shellStore } from '../state'
import { closePopup, isOpen, openPopup, usePopupStack } from '../popups'
import { useStore, useStorePart } from '../store'
import { computeGroups, Group, groupName } from './groups'
import { GroupIcon } from './icons'
import { glyphs } from './glyphs'
import { groupMenuItems } from './menus'
import { openPreview, previewPinnedFor, schedulePreviewClose, schedulePreviewOpen } from './preview'

/**
 * The taskbar at the top of the desktop: the Apps menu button, the pinned apps and running windows grouped by app,
 * and the tray (connection indicator, clock with the notification bell).
 */
export function Taskbar() {
  const state = useStore(shellStore)
  // subscribed to the popup stack, so the open states of the anchored buttons re-render
  usePopupStack()
  const groups = computeGroups(state.windows, state.pinned, state.apps)
  const { desktop, shell } = useCore()

  /** Clicking a group's button: launch a pinned app, (de)activate its only window, or show its previews. */
  const clickGroup = (group: Group, button: HTMLButtonElement) => {
    if (group.windows.length === 0) {
      if (group.app) {
        shell.launch(group.app.id)
      }
      return
    }
    if (group.windows.length === 1) {
      const [window] = group.windows
      closePopup()
      if (window.activated && !window.shownMinimized) {
        desktop.minimizeWindow(window.id)
      } else {
        desktop.activateWindow(window.id)
      }
      return
    }
    // several windows: pick one from the previews
    if (previewPinnedFor(group.key)) {
      closePopup()
      return
    }
    openPreview(group.key, button, true)
  }

  return (
    <header id="taskbar">
      <button
        type="button"
        id="apps-button"
        className={'taskbar-button' + (isOpen('apps-button') ? ' open' : '')}
        title="Apps"
        aria-label="Apps"
        aria-haspopup="true"
        aria-expanded={isOpen('apps-button')}
        data-popup-anchor="apps-button"
        onClick={() => (isOpen('apps-button') ? closePopup() : openPopup({ kind: 'apps', owner: 'apps-button' }))}
        dangerouslySetInnerHTML={{ __html: glyphs.apps(18) }}
      />
      <div id="taskbar-items" role="toolbar">
        {groups.map((group) => (
          <TaskbarButton key={group.key} group={group} onClick={clickGroup} />
        ))}
      </div>
      <Tray />
    </header>
  )
}

type TaskbarButtonProps = {
  group: Group
  onClick: (group: Group, button: HTMLButtonElement) => void
}

/** One taskbar button: an app (pinned and/or running), with a running indicator. */
function TaskbarButton({ group, onClick }: TaskbarButtonProps) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const { desktop, shell } = useCore()
  const active = group.windows.some((window) => window.activated && !window.shownMinimized)
  const name = groupName(group)
  return (
    <button
      ref={buttonRef}
      type="button"
      className={
        'taskbar-button app' +
        (group.windows.length > 0 ? ' running' : '') +
        (active ? ' active' : '') +
        (group.pinned ? ' pinned' : '')
      }
      data-group={group.key}
      data-windows={String(group.windows.length)}
      aria-label={group.windows.length > 1 ? `${name}, ${group.windows.length} windows` : name}
      // running groups get a preview instead of a tooltip
      title={group.windows.length === 0 ? name : ''}
      data-popup-anchor={group.key}
      onClick={() => buttonRef.current !== null && onClick(group, buttonRef.current)}
      onContextMenu={(event) => {
        event.preventDefault()
        openPopup({
          kind: 'context',
          owner: group.key,
          items: groupMenuItems(group, shell, desktop),
          x: event.clientX,
          y: event.clientY,
          nested: false,
        })
      }}
      onPointerEnter={(event) =>
        buttonRef.current && schedulePreviewOpen(group.key, buttonRef.current, event.pointerType)
      }
      onPointerLeave={() => schedulePreviewClose()}
    >
      <GroupIcon app={group.app} windows={group.windows} size={24} />
      <span className="indicator" />
    </button>
  )
}

function audioLabel(state: { muted: boolean; available: boolean; supported: boolean; running: boolean }): string {
  if (!state.supported) {
    return 'This browser cannot play the session audio'
  }
  if (state.muted) {
    return 'Sound is off, click to turn it on'
  }
  if (!state.available) {
    return 'This session has no audio'
  }
  return state.running ? 'Sound is on, click to mute' : 'Sound is on, click anywhere to start it'
}

/** The mute toggle: audio on or off for this viewer (a muted viewer's session doesn't even encode it). */
function MuteButton() {
  const audio = useStore(audioStore)
  const { audio: player } = useCore()
  const label = audioLabel(audio)
  return (
    <button
      type="button"
      id="audio-button"
      className={
        'taskbar-button tray-item' +
        (audio.muted ? ' muted' : '') +
        (audio.available && audio.supported ? '' : ' unavailable')
      }
      aria-pressed={audio.muted}
      aria-label={audio.muted ? 'Unmute' : 'Mute'}
      title={label}
      disabled={!audio.supported}
      onClick={() => player.toggleMuted()}
      dangerouslySetInnerHTML={{ __html: audio.muted ? glyphs.speakerMuted() : glyphs.speaker() }}
    />
  )
}

/** The right side of the taskbar: the mute toggle and the clock with the notification bell. */
function Tray() {
  const unseen = useStorePart(shellStore, (state) => state.unseen)
  const count = useStorePart(shellStore, (state) => state.notifications.length)
  const { shell } = useCore()
  const now = useClock()
  return (
    <div id="tray">
      <MuteButton />
      <button
        type="button"
        id="notifications-button"
        className={'taskbar-button tray-clock' + (unseen ? ' unseen' : '')}
        aria-haspopup="dialog"
        aria-expanded={isOpen('notifications-button')}
        aria-label={count ? `Notifications (${count})` : 'Notifications'}
        title={now.toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
        data-popup-anchor="notifications-button"
        onClick={() => (isOpen('notifications-button') ? closePopup() : shell.openPanel())}
      >
        <span className="bell" dangerouslySetInnerHTML={{ __html: glyphs.bell() }} />
        <span className="clock">{now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
      </button>
    </div>
  )
}

/** The current time, updated shortly after every minute. */
function useClock(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    let timer: number | undefined
    const schedule = () => {
      const current = new Date()
      // next minute
      timer = window.setTimeout(
        () => {
          setNow(new Date())
          schedule()
        },
        60_000 - (current.getSeconds() * 1000 + current.getMilliseconds()) + 50,
      )
    }
    schedule()
    return () => clearTimeout(timer)
  }, [])
  return now
}
