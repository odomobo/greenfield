// Copyright 2020 Erik De Rijcke
//
// This file is part of Greenfield.
//
// Greenfield is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// Greenfield is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Greenfield.  If not, see <https://www.gnu.org/licenses/>.

import { CursorType, hideBrowserCursor, resetBrowserCursor, setBrowserCursor, setCursor } from '../browser/pointer'
import { clearBrowserDndImage, setBrowserDndImage } from '../browser/dnd'
import BufferImplementation from '../BufferImplementation'
import { Callback } from '../Callback'
import { queueCancellableMicrotask } from '../Loop'
import { Point } from '../math/Point'
import Output from '../Output'
import { isDecodedFrame } from '../remote/DecodedFrame'
import Session from '../Session'
import Surface from '../Surface'
import View from '../View'
import { Scene } from './Scene'
import { CompositorRenderer } from './CompositorRenderer'
import { SceneGraph } from './SceneGraph'
import RenderState from './RenderState'
import { createPixmanRegion, copyTo, destroyPixmanRegion, fini, intersect, notEmpty } from '../Region'
import { isImageBitmapBufferContent } from '../ImageBitmapBuffer'

export function createRenderFrame(): Promise<number> {
  return new Promise<number>((resolve) => {
    requestAnimationFrame(resolve)
  })
}

function setupCanvasGLContext(canvas: HTMLCanvasElement): WebGLRenderingContext {
  const gl = canvas.getContext('webgl', {
    antialias: false,
    depth: false,
    alpha: true,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    // Low-latency mode leaves the canvas blank in Chrome on Windows with GPU acceleration.
    desynchronized: false,
  })
  if (gl === null) {
    throw new Error("This browser doesn't support WebGL!")
  }
  return gl
}

export default class Renderer implements CompositorRenderer {
  renderFrame?: Promise<void>
  private renderTaskRegistration?: () => void
  readonly sceneGraph: SceneGraph = new SceneGraph(() => this.render())

  private constructor(
    public readonly session: Session,
    public scenes: { [key: string]: Scene } = {},
    private frameCallbacks: Callback[] = [],
  ) {}

  get topLevelViews(): View[] {
    return this.sceneGraph.topLevelViews
  }

  static create(session: Session): Renderer {
    return new Renderer(session)
  }

  private createAndStoreScene(sceneId: string, canvas: HTMLCanvasElement, output: Output) {
    const scene = Scene.create(this.session, setupCanvasGLContext(canvas), canvas, output, sceneId, () => {
      this.render()
    })
    this.scenes = { ...this.scenes, [sceneId]: scene }
    scene.onDestroy().then(() => {
      delete this.scenes[sceneId]
      this.session.globals.unregisterOutput(output)
    })
    return scene
  }

  initScene(canvasProvider: () => { canvas: HTMLCanvasElement; id: string }): Scene {
    const { canvas, id } = canvasProvider()
    let scene = this.scenes[id]
    if (scene === undefined) {
      const output = Output.create(
        () => ({ width: canvas.width, height: canvas.height }),
        this.session.platform.userAgent,
        this.session.platform.orientationType,
      )
      this.session.globals.registerOutput(output)

      // TODO make sure this works well
      canvas.addEventListener('webglcontextlost', (event) => event.preventDefault(), false)
      canvas.addEventListener('webglcontextrestored', () => this.createAndStoreScene(id, canvas, output), false)

      // TODO sync output properties with scene
      // TODO notify client on which output their surfaces are being displayed
      scene = this.createAndStoreScene(id, canvas, output)
    }
    this.render()
    return scene
  }

  updateCursor(view: View, hotspot: Point): void {
    if (view.surface.state.bufferContents) {
      const cursorBufferContents = view.surface.state.bufferContents

      const cursorImage = cursorBufferContents.pixelContent as { bitmap: ImageBitmap | undefined } | undefined
      if (cursorImage === undefined || cursorImage.bitmap === undefined) {
        return
      }

      setBrowserCursor(cursorImage.bitmap, hotspot)
    } else {
      this.hideCursor()
    }
    for (const callback of view.surface.state.frameCallbacks) {
      callback.done(Date.now())
    }
    view.surface.state.frameCallbacks = []
    this.session.flush()
  }

  raiseSurface(surface: Surface): void {
    this.sceneGraph.raiseSurface(surface)
  }

  render(afterUpdatePixelContent?: () => void): void {
    if (this.renderTaskRegistration) {
      return
    }
    this.renderTaskRegistration = queueCancellableMicrotask(() => {
      this.renderTaskRegistration = undefined
      const sceneList = Object.values(this.scenes)
      if (sceneList.length === 0) {
        return
      }
      const viewStack = [...this.sceneGraph.updateViewStack()]
      for (const view of viewStack) {
        this.updateRenderStatesPixelContent(view)
        this.registerFrameCallbacks(view.surface.state.frameCallbacks)
        view.surface.state.frameCallbacks = []
      }

      afterUpdatePixelContent?.()
      // TODO we can check which views are damaged and filter out only those scenes that need a rerender
      if (this.renderFrame) {
        return
      }

      this.renderFrame = createRenderFrame().then((time) => {
        this.renderFrame = undefined
        // TODO we can further limit the visible region of each view by removing the area covered by other views
        const sceneList = Object.values(this.scenes)
        if (sceneList.length === 0) {
          return
        }
        for (const scene of sceneList) {
          scene.render(viewStack)
        }
        for (const callback of this.frameCallbacks) {
          callback.done(time)
        }
        this.frameCallbacks = []
        this.session.flush()
      })
    })
  }

  pickView(scenePoint: Point): View | undefined {
    return this.sceneGraph.pickView(scenePoint)
  }

  hideCursor(): void {
    hideBrowserCursor()
  }

  resetCursor(): void {
    resetBrowserCursor()
  }

  setCursorType(cursorType: CursorType): void {
    setCursor(cursorType)
  }

  clearDndImage(): void {
    clearBrowserDndImage()
  }

  updateDndImage(view: View): void {
    if (view.surface.state.bufferContents) {
      setBrowserDndImage(view.surface.state.bufferContents, view.positionOffset)
    } else {
      this.clearDndImage()
    }
    for (const callback of view.surface.state.frameCallbacks) {
      callback.done(Date.now())
    }
    view.surface.state.frameCallbacks = []
    this.session.flush()
  }

  removeTopLevelView(topLevelView: View): void {
    this.sceneGraph.removeTopLevelView(topLevelView)
  }

  hasTopLevelView(topLevelView: View): boolean {
    return this.sceneGraph.hasTopLevelView(topLevelView)
  }

  addTopLevelView(topLevelView: View): void {
    this.sceneGraph.addTopLevelView(topLevelView)
  }

  onViewDestroyed(view: View): void {
    for (const renderState of Object.values(view.renderStates)) {
      renderState.destroy()
    }
    view.renderStates = {}
  }

  onViewRegionUpdated(view: View): void {
    const scenesWithVisibleRegion = Object.values(this.scenes)
      .map((scene) => {
        const visibleRegion = createPixmanRegion()
        intersect(visibleRegion, view.pixmanRegion, scene.region)
        return [scene.id, { scene, visibleRegion }] as const
      })
      .filter(([, { visibleRegion }]) => {
        return notEmpty(visibleRegion)
      })

    for (const [sceneId, { scene, visibleRegion }] of scenesWithVisibleRegion) {
      const renderState = view.renderStates[sceneId]
      if (renderState === undefined) {
        const bufferSize = view.surface.state.bufferContents
          ? view.surface.state.bufferContents.size
          : { width: 0, height: 0 }
        const { width, height } = bufferSize
        view.renderStates[sceneId] = RenderState.create(scene.sceneShader.gl, { width, height }, scene, visibleRegion)
      } else {
        copyTo(renderState.visibleSceneRegion, visibleRegion)
        fini(visibleRegion)
        destroyPixmanRegion(visibleRegion)
      }
    }

    const visibleRegionBySceneId = Object.fromEntries(scenesWithVisibleRegion)
    for (const [sceneId, renderState] of Object.entries(view.renderStates)) {
      const visibleRegion = visibleRegionBySceneId[renderState.scene.id]
      if (visibleRegion === undefined) {
        renderState.destroy()
        delete view.renderStates[sceneId]
      }
    }

    view.relevantScene = Object.values(view.renderStates)[0]?.scene
  }

  private registerFrameCallbacks(frameCallbacks?: Callback[]): void {
    if (frameCallbacks) {
      this.frameCallbacks = [...this.frameCallbacks, ...frameCallbacks]
    }
  }

  private updateRenderStatesPixelContent(view: View): void {
    view.applyTransformations()
    const { buffer, bufferContents } = view.surface.state
    if (isDecodedFrame(bufferContents)) {
      if (view.mapped && buffer && view.surface.damaged) {
        const bufferImplementation = buffer.implementation as BufferImplementation<any>
        if (!bufferImplementation.released) {
          for (const renderState of Object.values(view.renderStates)) {
            renderState.scene[bufferContents.mimeType](bufferContents, renderState)
          }
          view.surface.damaged = false
          bufferImplementation.release()
        }
      }
    } else if (isImageBitmapBufferContent(bufferContents)) {
      for (const renderState of Object.values(view.renderStates)) {
        renderState.scene[bufferContents.mimeType](bufferContents, renderState)
      }
    } else if (buffer !== undefined && bufferContents === undefined) {
      if (view.mapped && buffer && view.surface.damaged) {
        const bufferImplementation = buffer.implementation as BufferImplementation<any>
        if (!bufferImplementation.released) {
          view.surface.damaged = false
          bufferImplementation.release()
        }
      }
    } else if (buffer !== undefined) {
      throw new Error(`BUG. Unsupported buffer type: ${typeof bufferContents}`)
    }
  }
}
