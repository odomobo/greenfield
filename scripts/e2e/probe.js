// WebSocket and sign-in probes for auth.sh. Usage:
//   probe.js ws <url> <origin> <first message>   prints the close code (or "open" if the socket stays up)
//   probe.js presence <base> <user> <password>   prints /api/me statuses: past the attach deadline with a presence,
//                                                after a reconnect blip, after the presence closed for good
// The gateway's timeouts (10 s to attach, 5 s grace) are divided by $TIME_SCALE (its --dev-time-scale).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const WebSocket = require(process.env.WS_MODULE)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const scale = Number(process.env.TIME_SCALE || 1)
const attachMs = 10_000 / scale
const graceMs = 5_000 / scale
const [mode, a, b, c] = process.argv.slice(2)

function open(url, origin, first) {
  const ws = new WebSocket(url, { origin, rejectUnauthorized: false })
  ws.on('open', () => ws.send(first))
  ws.on('error', () => {})
  return ws
}

async function main() {
  if (mode === 'ws') {
    const ws = open(a, b, c)
    console.log(await Promise.race([new Promise((resolve) => ws.on('close', resolve)), sleep(5000).then(() => 'open')]))
    process.exit(0)
  }
  const login = await fetch(`${a}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: a },
    body: JSON.stringify({ username: b, password: c }),
  })
  const { token } = await login.json()
  const me = async () => (await fetch(`${a}/api/me`, { headers: { Authorization: `Bearer ${token}` } })).status
  const control = a.replace(/^http/, 'ws') + '/control'
  let presence = open(control, a, token)
  await new Promise((resolve) => presence.once('message', resolve))
  // past the attach deadline, still signed in because the presence connection is there
  await sleep(attachMs + 1000)
  const withPresence = await me()
  // a blip well inside the grace period
  presence.terminate()
  await sleep(graceMs / 5)
  presence = open(control, a, token)
  await new Promise((resolve) => presence.once('message', resolve))
  // outlive the grace period the blip started: still signed in, because the presence is back
  await sleep(graceMs + 500)
  const afterBlip = await me()
  presence.close()
  await sleep(graceMs + 1000)
  console.log(withPresence, afterBlip, await me())
  process.exit(0)
}
main()
