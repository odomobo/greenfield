# Viewer

Browser viewer and window manager for server-side sessions. The session (compositor + apps) runs on the server
inside the proxy; the viewer renders its windows, does hit testing, interactive move/resize and window placement, and
can disconnect and reattach at any time without the apps noticing.

## Running (development)

```bash
# server: proxy on :8081, allowing the viewer's origin for /apps and /launch
cd packages/compositor-proxy-cli
env -u DISPLAY yarn run run --applications=$HOME/greenfield-apps.json --allow-origin=http://localhost:8090

# viewer on :8090
cd packages/viewer
yarn start --port 8090
```

Open `http://localhost:8090/`. Query parameters:

- `server=host:port` proxy to connect to (default: same host, port 8081)
- `session=name` session to attach to (default: `default`)
- `secure=1` use `wss://`/`https://` (default when the page itself is served over https)
- `test=1` expose test hooks (`window.__viewerTest`), used by `scripts/test-reattach.sh`

Opening a second viewer on the same session takes it over; the first one shows a "taken over" message.

## Protocol

One WebSocket per session, see [src/protocol.ts](src/protocol.ts) for the envelope and all message types.
