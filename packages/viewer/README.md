# Viewer

Browser viewer and window manager for server-side sessions. The session (compositor + apps) runs on the server
in a per-user session process behind the gateway; the viewer renders its windows, does hit testing, interactive move/resize and window placement, and
can disconnect and reattach at any time without the apps noticing.

## Running

The viewer is served by the gateway (`packages/gateway`) at `/desktop/?session=<id>` after logging in; it talks to
the gateway same-origin (`/api/me`, `/api/apps`, `/api/sessions`, `POST /api/sessions/<id>/launch`, WebSocket
`/ws?session=<id>`). Build it with `yarn build`; see the gateway README for running everything.

Query parameters:

- `session=<id>` session to attach to (set by the session picker)
- `test=1` expose test hooks (`window.__viewerTest`), used by `scripts/test-gateway.sh`

Opening a second viewer on the same session takes it over; the first one shows a "taken over" message.

## Protocol

One WebSocket per session, see [src/protocol.ts](src/protocol.ts) for the envelope and all message types.
