import { createContext, useContext } from 'react'
import { Connection } from './connection'
import { Desktop } from './desktop'
import type { ShellController } from './shell/shell'

/**
 * The imperative core of the desktop, mounted once (see app.tsx): the session connection, the
 * window manager (which owns the window elements) and the shell controller. React components reach it through this context to ask for window
 * operations or to send messages; rendering state travels the other way, through the stores.
 */
export type Core = {
  connection: Connection
  desktop: Desktop
  shell: ShellController
}

export const CoreContext = createContext<Core | null>(null)

export function useCore(): Core {
  const core = useContext(CoreContext)
  if (core === null) {
    throw new Error('BUG. The desktop is not mounted.')
  }
  return core
}
