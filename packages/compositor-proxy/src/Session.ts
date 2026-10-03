// Copyright 2019 Erik De Rijcke
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

import { createLogger } from './Logger.js'

import { createNativeCompositorSession, NativeWaylandCompositorSession } from './NativeWaylandCompositorSession.js'
import { NativeAppContext } from './NativeAppContext.js'
import { Configschema } from './config.js'

// TODO create logger per proxy session instance
const logger = createLogger('compositor-proxy-session')

export function createSession(compositorSessionId: string, config: Configschema): Session {
  return new Session(compositorSessionId, config)
}

export class Session {
  public compositorPeerIdentity?: string

  public readonly nativeWaylandCompositorSession: NativeWaylandCompositorSession
  private nativeAppContexts: NativeAppContext[] = []
  public closeListeners: (() => void)[] = []

  constructor(
    readonly compositorSessionId: string,
    readonly config: Configschema,
  ) {
    this.nativeWaylandCompositorSession = createNativeCompositorSession(this)
    // TODO XWayland: the X window manager still needs to be ported to the server-side compositor.
    logger.info(`Session created.`)
  }

  close() {
    this.compositorPeerIdentity = undefined
    this.nativeWaylandCompositorSession.destroy()
    for (const closeListener of this.closeListeners) {
      closeListener()
    }
  }

  createNativeAppContext(pid: number, name: string, external: boolean) {
    const nativeAppContext = new NativeAppContext(this, pid, name, external)
    this.nativeAppContexts.push(nativeAppContext)
    nativeAppContext.destroyListeners.push(() => {
      this.nativeAppContexts = this.nativeAppContexts.filter(
        (otherNativeAppContext) => otherNativeAppContext !== nativeAppContext,
      )
    })

    return nativeAppContext
  }

  findNativeAppContextByPid(pid: number) {
    return this.nativeAppContexts.find((nativeAppContext) => nativeAppContext.pid === pid)
  }
}
