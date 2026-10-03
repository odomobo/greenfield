# Viewer

Browser viewer and window manager for server-side sessions. The session (compositor + apps) runs on the server
in a per-user session process behind the gateway; the viewer renders its windows, does hit testing, interactive move/resize and window placement, and
can disconnect and reattach at any time without the apps noticing.

## Running

The viewer is the gateway's one page (`packages/gateway`, served at `/`): the sign-in form, the session list (open
by clicking a row, rename by clicking the name, end) and the desktop. Signing in lasts only as long as the page (see
the gateway README and [src/auth.ts](src/auth.ts)), so it never navigates away. It talks to the gateway same-origin
with a bearer token: `POST /api/login`, `/api/logout`, `/api/me`, `/api/apps`, `GET`/`POST /api/sessions`,
`POST /api/sessions/<id>/{launch,rename,end}`, WebSockets `/control` (presence) and `/ws?session=<id>` (the session),
each sending the token as its first message. Build it with `yarn build`; see the gateway README for running
everything.

Query parameters:

- `test=1` expose test hooks (`window.__viewerTest`), used by `scripts/test-gateway.sh`

In the desktop, Disconnect goes back to the session list (the session keeps running); Log out ends the session and
signs out.

Opening a second viewer on the same session takes it over; the first one shows a "taken over" message.

## Protocol

One WebSocket per session, see [src/protocol.ts](src/protocol.ts) for the envelope and all message types.
