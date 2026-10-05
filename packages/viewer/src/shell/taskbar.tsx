import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useCore } from '../core'
import { appStore, audioStore, shellStore } from '../state'
import { closePopup, isOpen, openPopup, usePopupStack } from '../popups'
import { useStore, useStorePart } from '../store'
import { computeGroups, Group, groupName } from './groups'
import { GroupIcon } from './icons'
import { glyphs } from './glyphs'
import { groupMenuItems } from './menus'
import { openPreview, previewPinnedFor, schedulePreviewClose, schedulePreviewOpen } from './preview'
import { usePresence } from './presence'
import { reducedMotion } from '../animation'

/** How long a taskbar button takes to grow in or shrink away (the .leaving animation in style.css too). */
const BUTTON_ANIMATION_MS = 160
/** Buttons that show up this soon after connecting are the session's as it was (pinned apps, open windows): no growing. */
const SETTLE_MS = 1000

/**
 * The taskbar at the top of the desktop: the Apps menu button, the pinned apps and running windows grouped by app,
 * and the tray (connection indicator, clock with the notification bell).
 */
export function Taskbar() {
  const state = useStore(shellStore)
  // subscribed to the popup stack, so the open states of the anchored buttons re-render
  usePopupStack()
  // groups that went stay a moment, shrinking away
  const groups = usePresence(computeGroups(state.windows, state.pinned, state.apps), (group) => group.key, BUTTON_ANIMATION_MS)
  const { desktop, shell } = useCore()
  // the buttons that come with the session when it's attached don't grow in, only those that come later
  const connected = useStorePart(appStore, (app) => app.connection.kind === 'connected')
  const connectedAt = useRef<number | undefined>(undefined)
  if (!connected) {
    connectedAt.current = undefined
  } else if (connectedAt.current === undefined) {
    connectedAt.current = performance.now()
  }
  const growIn = connectedAt.current !== undefined && performance.now() - connectedAt.current > SETTLE_MS

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
        {groups.map(({ item: group, leaving }) => (
          <TaskbarButton key={group.key} group={group} onClick={clickGroup} leaving={leaving} growIn={growIn} />
        ))}
      </div>
      <Tray />
    </header>
  )
}

type TaskbarButtonProps = {
  group: Group
  onClick: (group: Group, button: HTMLButtonElement) => void
  /** the group is gone: shrinking away, no input, not a group's button anymore */
  leaving: boolean
  /** grow in when it appears */
  growIn: boolean
}

/**
 * One taskbar button: an app (pinned and/or running), with a running indicator. A new one grows in, from no width (so
 * the buttons after it make room smoothly); a gone one shrinks away the same way (.leaving in style.css).
 */
function TaskbarButton({ group, onClick, leaving, growIn }: TaskbarButtonProps) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  // (an animation of its own, not a CSS one: the button's classes change while it runs)
  useLayoutEffect(() => {
    if (growIn && !reducedMotion()) {
      buttonRef.current?.animate(
        [{ opacity: 0, scale: '0.6', width: '0px', minWidth: '0px', paddingInline: '0px', marginInlineEnd: '-2px' }, {}],
        { duration: BUTTON_ANIMATION_MS, easing: 'cubic-bezier(0, 0, 0.3, 1)' },
      )
    }
  }, [])
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
        (group.pinned ? ' pinned' : '') +
        (leaving ? ' leaving' : '')
      }
      data-group={leaving ? undefined : group.key}
      data-windows={String(group.windows.length)}
      aria-label={group.windows.length > 1 ? `${name}, ${group.windows.length} windows` : name}
      // running groups get a preview instead of a tooltip
      title={group.windows.length === 0 ? name : ''}
      data-popup-anchor={leaving ? undefined : group.key}
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
