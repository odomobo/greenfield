import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useCore } from '../core'
import { appStore, audioStore, HostClock, shellStore } from '../state'
import { closeAbove, closePopup, closePopupOf, isOpen, openPopup, usePopupStack } from '../popups'
import { createStore, useStore, useStorePart } from '../store'
import { computeGroups, Group, groupName } from './groups'
import { GroupIcon } from './icons'
import { glyphs } from './glyphs'
import { groupMenuItems } from './menus'
import {
  closePreview,
  openPreview,
  OVERFLOW_OWNER,
  previewPinnedFor,
  schedulePreviewClose,
  schedulePreviewOpen,
} from './preview'
import { usePresence } from './presence'
import { reducedMotion } from '../animation'
import { trayMenuOwner } from './tray'
import { formatDate, formatTime, hostNow } from './clock'
import type { ShellTrayItem } from '../protocol'

/** How long a taskbar button takes to grow in or shrink away (the .leaving animation in style.css too). */
const BUTTON_ANIMATION_MS = 160
/** Buttons that show up this soon after connecting are the session's as it was (pinned apps, open windows): no growing. */
const SETTLE_MS = 1000

/** How far (CSS pixels) a taskbar button is dragged before it moves: less is a click. */
const DRAG_THRESHOLD = 6
/** The taskbar's overflow flyout: at most this many buttons in a row. */
const OVERFLOW_COLUMNS = 6

/** The groups whose buttons don't fit on the taskbar, in order: they're in the overflow flyout (TaskbarOverflow). */
const overflowStore = createStore<{ keys: string[] }>({ keys: [] })

/**
 * The taskbar at the top of the desktop: the Apps menu button, the pinned apps and running windows grouped by app,
 * and the tray (the apps' tray icons, the mute toggle, the clock with the notification bell). The buttons can be
 * dragged into another order; those that don't fit go into a flyout under a '…' button at the end.
 */
export function Taskbar() {
  const state = useStore(shellStore)
  // subscribed to the popup stack, so the open states of the anchored buttons re-render
  usePopupStack()
  // groups that went stay a moment, shrinking away
  const groups = usePresence(computeGroups(state.windows, state.pinned, state.apps), (group) => group.key, BUTTON_ANIMATION_MS)
  const { shell } = useCore()
  const clickGroup = useClickGroup(false)
  // the buttons that come with the session when it's attached don't grow in, only those that come later
  const connected = useStorePart(appStore, (app) => app.connection.kind === 'connected')
  const connectedAt = useRef<number | undefined>(undefined)
  if (!connected) {
    connectedAt.current = undefined
  } else if (connectedAt.current === undefined) {
    connectedAt.current = performance.now()
  }
  const growIn = connectedAt.current !== undefined && performance.now() - connectedAt.current > SETTLE_MS

  // how many buttons fit: all of them, or all but one, which makes room for the '…' button
  const itemsRef = useRef<HTMLDivElement>(null)
  const fit = useFittingButtons(itemsRef)
  const present = groups.filter(({ leaving }) => !leaving).map(({ item }) => item)
  const shownCount = present.length <= fit ? present.length : Math.max(0, fit - 1)
  const shown = new Set(present.slice(0, shownCount).map((group) => group.key))
  const overflow = present.slice(shownCount).map((group) => group.key)
  useEffect(() => {
    const keys = overflowStore.get().keys
    if (keys.length !== overflow.length || keys.some((key, i) => key !== overflow[i])) {
      overflowStore.update({ keys: overflow })
    }
    if (overflow.length === 0) {
      closePopupOf(OVERFLOW_OWNER)
    }
  })

  useReorderDrag(itemsRef, (keys) => shell.reorderTaskbar(keys))

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
      <div id="taskbar-items" role="toolbar" ref={itemsRef}>
        {groups
          .filter(({ item, leaving }) => leaving || shown.has(item.key))
          .map(({ item: group, leaving }) => (
            <TaskbarButton
              key={group.key}
              group={group}
              onClick={clickGroup}
              leaving={leaving}
              growIn={growIn}
              inOverflow={false}
            />
          ))}
        {overflow.length > 0 && (
          <button
            type="button"
            id="taskbar-overflow-button"
            className={'taskbar-button overflow' + (isOpen(OVERFLOW_OWNER) ? ' open' : '')}
            title={`${overflow.length} more`}
            aria-label={`${overflow.length} more apps`}
            aria-haspopup="true"
            aria-expanded={isOpen(OVERFLOW_OWNER)}
            data-popup-anchor={OVERFLOW_OWNER}
            onClick={() =>
              isOpen(OVERFLOW_OWNER) ? closePopupOf(OVERFLOW_OWNER) : openPopup({ kind: 'overflow', owner: OVERFLOW_OWNER })
            }
            dangerouslySetInnerHTML={{ __html: glyphs.more() }}
          />
        )}
      </div>
      <Tray growIn={growIn} />
    </header>
  )
}

/**
 * The flyout of the taskbar buttons that don't fit, under its '…' button: the same buttons (click, right click,
 * previews), in rows. Rendered by the popup layer.
 */
export function TaskbarOverflow() {
  const state = useStore(shellStore)
  const keys = useStore(overflowStore).keys
  const clickGroup = useClickGroup(true)
  const groups = computeGroups(state.windows, state.pinned, state.apps).filter((group) => keys.includes(group.key))
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | undefined>(undefined)
  useLayoutEffect(() => {
    const anchor = document.querySelector(`[data-popup-anchor="${OVERFLOW_OWNER}"]`)
    const flyout = ref.current
    if (anchor === null || flyout === null) {
      return
    }
    const rect = anchor.getBoundingClientRect()
    const width = flyout.offsetWidth
    setPosition({ left: Math.max(4, Math.min(rect.left, window.innerWidth - width - 4)), top: rect.bottom + 4 })
  }, [groups.length])
  return (
    <div
      ref={ref}
      id="taskbar-overflow"
      className="flyout"
      role="toolbar"
      data-popup-owner={OVERFLOW_OWNER}
      style={{
        gridTemplateColumns: `repeat(${Math.min(OVERFLOW_COLUMNS, Math.max(1, groups.length))}, auto)`,
        ...(position === undefined ? { visibility: 'hidden' } : { left: `${position.left}px`, top: `${position.top}px` }),
      }}
    >
      {groups.map((group) => (
        <TaskbarButton key={group.key} group={group} onClick={clickGroup} leaving={false} growIn={false} inOverflow />
      ))}
    </div>
  )
}

/**
 * Clicking a group's button: launch a pinned app, (de)activate its only window, or show its previews. inOverflow: the
 * button is in the overflow flyout, which a launch closes and previews open over.
 */
function useClickGroup(inOverflow: boolean): (group: Group, button: HTMLButtonElement) => void {
  const { desktop, shell } = useCore()
  return (group, button) => {
    if (group.windows.length === 0) {
      if (group.app) {
        if (inOverflow) {
          closePopup()
        }
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
      closePreview()
      return
    }
    openPreview(group.key, button, true)
  }
}

/** How many app buttons fit on the taskbar (a button and the gap after it are as wide as the taskbar is high). */
function useFittingButtons(ref: React.RefObject<HTMLElement>): number {
  const [fit, setFit] = useState(Infinity)
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) {
      return
    }
    const measure = () => {
      const slot = parseFloat(getComputedStyle(element).getPropertyValue('--taskbar-height')) || 48
      const gap = parseFloat(getComputedStyle(element).columnGap) || 0
      setFit(Math.max(1, Math.floor((element.clientWidth + gap) / slot)))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return fit
}

/**
 * Dragging the app buttons of the taskbar into another order: the button follows the pointer, the others make room,
 * and on release `reorder` gets the new order of the buttons (group keys). Imperative (transforms on the buttons, no
 * renders while dragging); the click that ends a drag is swallowed.
 */
function useReorderDrag(ref: React.RefObject<HTMLElement>, reorder: (keys: string[]) => void) {
  const reorderRef = useRef(reorder)
  reorderRef.current = reorder
  useEffect(() => {
    const container = ref.current
    if (container === null) {
      return
    }
    type Drag = {
      button: HTMLElement
      pointerId: number
      startX: number
      // set once it moved past the threshold
      buttons?: HTMLElement[]
      index: number
      target: number
      slot: number
    }
    let drag: Drag | undefined
    const appButtons = () => [...container.querySelectorAll<HTMLElement>('.taskbar-button.app[data-group]')]

    const down = (event: PointerEvent) => {
      const button = (event.target as Element).closest<HTMLElement>('.taskbar-button.app[data-group]')
      if (event.button !== 0 || button === null || drag !== undefined) {
        return
      }
      drag = { button, pointerId: event.pointerId, startX: event.clientX, index: 0, target: 0, slot: 0 }
    }

    const move = (event: PointerEvent) => {
      if (drag === undefined || event.pointerId !== drag.pointerId) {
        return
      }
      const dx = event.clientX - drag.startX
      if (drag.buttons === undefined) {
        if (Math.abs(dx) < DRAG_THRESHOLD) {
          return
        }
        const buttons = appButtons()
        drag.index = drag.target = buttons.indexOf(drag.button)
        if (drag.index < 0 || buttons.length < 2) {
          drag = undefined
          return
        }
        drag.buttons = buttons
        drag.slot = buttons[1].getBoundingClientRect().left - buttons[0].getBoundingClientRect().left
        drag.button.setPointerCapture(event.pointerId)
        drag.button.classList.add('dragging')
        container.classList.add('reordering')
        closePreview()
      }
      const { buttons, index, slot } = drag
      const offset = Math.max(-index * slot, Math.min(dx, (buttons.length - 1 - index) * slot))
      drag.button.style.transform = `translateX(${offset}px)`
      const target = Math.max(0, Math.min(buttons.length - 1, Math.round(index + offset / slot)))
      drag.target = target
      buttons.forEach((button, i) => {
        if (i !== index) {
          const shift = i > index && i <= target ? -slot : i < index && i >= target ? slot : 0
          button.style.transform = shift ? `translateX(${shift}px)` : ''
        }
      })
    }

    const end = (event: PointerEvent) => {
      if (drag === undefined || event.pointerId !== drag.pointerId) {
        return
      }
      const { buttons, index, target, button } = drag
      drag = undefined
      if (buttons === undefined) {
        return
      }
      container.classList.remove('reordering')
      button.classList.remove('dragging')
      for (const each of buttons) {
        each.style.transform = ''
      }
      // the click this release makes isn't one
      const swallow = (click: MouseEvent) => {
        click.stopPropagation()
        click.preventDefault()
      }
      window.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
      if (event.type === 'pointerup' && target !== index) {
        const keys = buttons.map((each) => each.dataset.group!)
        const [moved] = keys.splice(index, 1)
        keys.splice(target, 0, moved)
        reorderRef.current(keys)
      }
    }

    container.addEventListener('pointerdown', down)
    container.addEventListener('pointermove', move)
    container.addEventListener('pointerup', end)
    container.addEventListener('pointercancel', end)
    return () => {
      container.removeEventListener('pointerdown', down)
      container.removeEventListener('pointermove', move)
      container.removeEventListener('pointerup', end)
      container.removeEventListener('pointercancel', end)
    }
  }, [ref])
}

type TaskbarButtonProps = {
  group: Group
  onClick: (group: Group, button: HTMLButtonElement) => void
  /** the group is gone: shrinking away, no input, not a group's button anymore */
  leaving: boolean
  /** grow in when it appears */
  growIn: boolean
  /** in the overflow flyout: its menus and previews open over the flyout */
  inOverflow: boolean
}

/**
 * One taskbar button: an app (pinned and/or running), with a running indicator. A new one grows in, from no width (so
 * the buttons after it make room smoothly); a gone one shrinks away the same way (.leaving in style.css).
 */
function TaskbarButton({ group, onClick, leaving, growIn, inOverflow }: TaskbarButtonProps) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  useGrowIn(buttonRef, growIn)
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
        if (inOverflow) {
          // (above the flyout, instead of a preview)
          closeAbove(1)
        }
        openPopup(
          {
            kind: 'context',
            owner: group.key,
            items: groupMenuItems(group, shell, desktop),
            x: event.clientX,
            y: event.clientY,
            nested: inOverflow,
          },
          inOverflow,
        )
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

/**
 * A new button grows in, from no width (so the buttons after it make room smoothly). An animation of its own, not a
 * CSS one: the button's classes change while it runs.
 */
function useGrowIn(ref: React.RefObject<HTMLElement>, growIn: boolean) {
  useLayoutEffect(() => {
    if (growIn && !reducedMotion()) {
      ref.current?.animate(
        [{ opacity: 0, scale: '0.6', width: '0px', minWidth: '0px', paddingInline: '0px', marginInlineEnd: '-2px' }, {}],
        { duration: BUTTON_ANIMATION_MS, easing: 'cubic-bezier(0, 0, 0.3, 1)' },
      )
    }
  }, [])
}

/** Wheel distance (in Chromium's pixels) per wheel click sent to a tray item: a mouse wheel's click is 100 px. */
const WHEEL_CLICK_PIXELS = 100
/** A line (Firefox's wheel deltas) in pixels: a click is 3 lines. */
const LINE_PIXELS = WHEEL_CLICK_PIXELS / 3

/** The apps' tray icons (StatusNotifierItems) that aren't passive, in the order they came. */
function TrayItems({ growIn }: { growIn: boolean }) {
  const tray = useStorePart(shellStore, (state) => state.tray)
  const shown = usePresence(
    tray.filter((item) => item.status !== 'passive'),
    (item) => item.id,
    BUTTON_ANIMATION_MS,
  )
  return (
    <>
      {shown.map(({ item, leaving }) => (
        <TrayIcon key={item.id} item={item} leaving={leaving} growIn={growIn} />
      ))}
    </>
  )
}

/**
 * One tray icon: left click activates the app (or shows the menu, for items that are menus), middle click is its
 * secondary action, right click its menu, the wheel scrolls it. A second click while its menu is open closes it.
 */
function TrayIcon({ item, leaving, growIn }: { item: ShellTrayItem; leaving: boolean; growIn: boolean }) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  useGrowIn(buttonRef, growIn)
  const { shell } = useCore()
  const wheel = useRef({ x: 0, y: 0 })
  const owner = trayMenuOwner(item.id)
  const open = isOpen(owner)

  const click = (action: 'activate' | 'secondary' | 'context') => {
    if (isOpen(owner)) {
      closePopup()
      return
    }
    // menus open under the icon
    const rect = buttonRef.current!.getBoundingClientRect()
    shell.tray.click(item.id, action, Math.round(rect.left), Math.round(rect.bottom + 4))
  }

  const tooltip = item.tooltip
    ? [item.tooltip.title || item.title, item.tooltip.body].filter(Boolean).join('\n')
    : item.title
  return (
    <button
      ref={buttonRef}
      type="button"
      className={
        'taskbar-button tray-item app-tray-item' +
        (open ? ' open' : '') +
        (item.status === 'attention' ? ' attention' : '') +
        (leaving ? ' leaving' : '')
      }
      data-tray-item={leaving ? undefined : item.id}
      data-popup-anchor={leaving ? undefined : owner}
      aria-label={item.title || 'Tray icon'}
      aria-haspopup={item.menu ? 'menu' : undefined}
      title={tooltip}
      onClick={() => click('activate')}
      onMouseDown={(event) => {
        // no autoscroll
        if (event.button === 1) {
          event.preventDefault()
        }
      }}
      onAuxClick={(event) => {
        if (event.button === 1) {
          click('secondary')
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        click('context')
      }}
      onWheel={(event) => {
        const scale = event.deltaMode === 1 ? LINE_PIXELS : event.deltaMode === 2 ? WHEEL_CLICK_PIXELS * 3 : 1
        const accumulated = wheel.current
        accumulated.x += event.deltaX * scale
        accumulated.y += event.deltaY * scale
        for (const axis of ['y', 'x'] as const) {
          const clicks = Math.trunc(accumulated[axis] / WHEEL_CLICK_PIXELS)
          if (clicks !== 0) {
            accumulated[axis] -= clicks * WHEEL_CLICK_PIXELS
            shell.tray.scroll(item.id, clicks * 120, axis === 'y' ? 'vertical' : 'horizontal')
          }
        }
      }}
    >
      {item.icon ? (
        <img src={item.icon} alt="" width={20} height={20} draggable={false} />
      ) : (
        <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: glyphs.app(20) }} />
      )}
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

/** The right side of the taskbar: the apps' tray icons, the mute toggle and the clock with the notification bell. */
function Tray({ growIn }: { growIn: boolean }) {
  const unseen = useStorePart(shellStore, (state) => state.unseen)
  const count = useStorePart(shellStore, (state) => state.notifications.length)
  const { shell } = useCore()
  const clock = useStorePart(shellStore, (state) => state.clock)
  const now = useClock(clock)
  return (
    <div id="tray">
      <TrayItems growIn={growIn} />
      <MuteButton />
      <button
        type="button"
        id="notifications-button"
        className={'taskbar-button tray-clock' + (unseen ? ' unseen' : '')}
        aria-haspopup="dialog"
        aria-expanded={isOpen('notifications-button')}
        aria-label={count ? `Notifications (${count})` : 'Notifications'}
        title={formatDate(now, clock)}
        data-popup-anchor="notifications-button"
        onClick={() => (isOpen('notifications-button') ? closePopup() : shell.openPanel())}
      >
        <span className="bell" dangerouslySetInnerHTML={{ __html: glyphs.bell() }} />
        <span className="clock">{formatTime(now, clock)}</span>
      </button>
    </div>
  )
}

/** The host's current time (see clock.ts), updated shortly after every one of its minutes. */
function useClock(clock: HostClock | undefined): Date {
  const [now, setNow] = useState(() => hostNow(clock))
  useEffect(() => {
    let timer: number | undefined
    const schedule = () => {
      const current = hostNow(clock)
      setNow(current)
      // next minute
      timer = window.setTimeout(schedule, 60_000 - (current.getSeconds() * 1000 + current.getMilliseconds()) + 50)
    }
    schedule()
    return () => clearTimeout(timer)
  }, [clock])
  return now
}
