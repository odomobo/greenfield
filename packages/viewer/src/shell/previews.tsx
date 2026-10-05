import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useCore } from '../core'
import { closePopup, openPopup } from '../popups'
import { shellStore } from '../state'
import { ShellWindow } from '../desktop'
import { useStore } from '../store'
import { computeGroups, Group, groupName } from './groups'
import { GroupIcon } from './icons'
import { glyphs } from './glyphs'
import { windowMenuItems } from './menus'
import { cancelPreviewClose, schedulePreviewClose } from './preview'
import type { PreviewPopup } from '../popups'

const PREVIEW_WIDTH = 200
const PREVIEW_HEIGHT = 120
const PREVIEW_REFRESH_MS = 250

/**
 * The window previews of a taskbar group, shown under its button: one card per window with its title, a close button and a
 * snapshot of its content, refreshed at a fixed rate straight onto the cards' canvases (no React
 * state - the images never pass through a render, nor through JavaScript memory).
 */
export function WindowPreview({ entry }: { entry: PreviewPopup }) {
  const { desktop } = useCore()
  const state = useStore(shellStore)
  const group = computeGroups(state.windows, state.pinned, state.apps).find((g) => g.key === entry.owner)
  const [position, setPosition] = useState<{ left: number; top: number } | undefined>(undefined)
  const containerRef = useRef<HTMLDivElement>(null)
  const canvases = useRef(new Map<string, HTMLCanvasElement>())

  // the group is gone (its last window closed): put the preview away
  useEffect(() => {
    if (group === undefined || group.windows.length === 0) {
      closePopup()
    }
  }, [group])

  const refreshImages = useCallback(() => {
    for (const [id, canvas] of canvases.current) {
      desktop.drawPreview(id, canvas, PREVIEW_WIDTH, PREVIEW_HEIGHT)
    }
  }, [desktop])

  // new cards start with an image right away, the others follow at the refresh rate
  useEffect(() => {
    refreshImages()
  }, [refreshImages, group])
  useEffect(() => {
    const interval = window.setInterval(refreshImages, PREVIEW_REFRESH_MS)
    return () => clearInterval(interval)
  }, [refreshImages])

  // under the button, inside the window
  useLayoutEffect(() => {
    const element = containerRef.current
    if (element === null) {
      return
    }
    const anchor = entry.anchorRect
    const width = element.offsetWidth
    setPosition({
      left: Math.max(4, Math.min(anchor.left + anchor.width / 2 - width / 2, window.innerWidth - width - 4)),
      top: anchor.bottom + 4,
    })
  }, [entry.anchorRect])

  if (group === undefined || group.windows.length === 0) {
    return null
  }
  return (
    <div
      ref={containerRef}
      id="window-preview"
      className="flyout"
      data-popup-owner={entry.owner}
      style={
        position === undefined
          ? { visibility: 'hidden' }
          : { left: `${position.left}px`, top: `${position.top}px` }
      }
      onPointerEnter={() => cancelPreviewClose()}
      onPointerLeave={() => schedulePreviewClose()}
    >
      {group.windows.map((window) => (
        <PreviewCard key={window.id} window={window} group={group} canvases={canvases.current} />
      ))}
    </div>
  )
}

type PreviewCardProps = {
  window: ShellWindow
  group: Group
  canvases: Map<string, HTMLCanvasElement>
}

function PreviewCard({ window, group, canvases }: PreviewCardProps) {
  const { desktop } = useCore()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) {
      return
    }
    canvases.set(window.id, canvas)
    return () => {
      canvases.delete(window.id)
    }
  }, [window.id, canvases])

  const activate = () => {
    closePopup()
    desktop.activateWindow(window.id)
  }

  return (
    <div
      className={'preview-card' + (window.activated && !window.shownMinimized ? ' active' : '')}
      data-window={window.id}
      role="button"
      tabIndex={0}
      title={window.title}
      onClick={activate}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          activate()
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        // (nested: the menu opens above the preview)
        openPopup(
          {
            kind: 'context',
            owner: `preview:${window.id}`,
            items: windowMenuItems(window, desktop),
            x: event.clientX,
            y: event.clientY,
            nested: true,
          },
          true,
        )
      }}
    >
      <div className="preview-header">
        <GroupIcon app={group.app} windows={[window]} size={16} />
        <span className="preview-title">{window.title || groupName(group)}</span>
        <div className="preview-controls">
          <button
            type="button"
            data-action="close"
            title="Close"
            aria-label="Close"
            onClick={(event) => {
              event.stopPropagation()
              desktop.closeWindow(window.id)
            }}
            dangerouslySetInnerHTML={{ __html: glyphs.close(12) }}
          />
        </div>
      </div>
      <canvas className="preview-image" ref={canvasRef} />
    </div>
  )
}
