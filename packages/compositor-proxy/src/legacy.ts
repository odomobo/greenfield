// The old stack (the libwayland fork and the TypeScript compositor), still selectable with GFLD_LEGACY_COMPOSITOR=1
// until it's deleted (ROADMAP.md, Core item 1, wave 2). Loads the fork's addons: never import it in a process that
// uses the wlroots core (index.ts).
export { createLogger } from './Logger.js'
export { initSurfaceBufferEncoding } from './SurfaceBufferEncoding.js'
export { createSessionController, SessionController } from './SessionController.js'
export { createSession, Session } from './Session.js'
export { launchApplication, NativeAppContext } from './NativeAppContext.js'
export { Configschema } from './config.js'
export { startServerCompositor } from './InProcessCompositor.js'
export type { ShellEndpoint, ViewerHost } from './viewer/ViewerHost.js'
export type { ControlMessage } from './viewer/ViewerTransport.js'
