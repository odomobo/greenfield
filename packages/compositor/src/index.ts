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

/**
 * Types shared by the compositor core. The compositor runs server-side, see server/index.ts for its entry point.
 */
import type { GreenfieldLogger } from './Session'
import type { nrmlvo } from './Xkb'

export * from './ButtonEvent'
export * from './AxisEvent'
export * from './KeyEvent'
export type { nrmlvo }
export type { GreenfieldLogger }

export interface CompositorSurface {
  id: number
  client: CompositorClient
}

export interface CompositorClient {
  id: string
}

export interface CompositorConfiguration {
  scrollFactor: number
  keyboardLayoutName?: string
}

export interface SessionConfig {
  id?: string
  mode: 'floating'
}
