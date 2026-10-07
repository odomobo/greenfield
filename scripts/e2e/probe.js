// WebSocket sign-in probes for the e2e scripts (the in-band sign-in on /ws, see "Sign-in" in libs/scene-protocol).
// Usage:
//   probe.js signin <wss-url> <origin> <user> <password>
//       signs in; prints "<ok|fail|closed> <seconds> <close code> <message>": the outcome, the time from the answer to
//       the result, the close code (0 while open) and the result's message (the username when signed in). A
//       successful sign-in closes again right away (the desktop keeps running).
//   probe.js failures <wss-url> <origin> <user> <count>
//       that many sign-ins with wrong passwords side by side; prints their messages, one per line
//   probe.js raw <wss-url> <origin> <first frame>
//       sends the frame as the first message (text; "--binary" sends a binary one) and prints the close code, or "open"
//       if the socket stays up for 5 s
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const WebSocket = require(process.env.WS_MODULE)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const [mode, url, origin, a, b] = process.argv.slice(2)

function open() {
  const ws = new WebSocket(url, { origin, rejectUnauthorized: false })
  ws.on('error', () => {})
  return ws
}

/** One sign-in attempt: { outcome, seconds, code, message }. */
function signIn(username, password) {
  return new Promise((resolve) => {
    const ws = open()
    let answeredAt
    let result
    const timer = setTimeout(() => ws.terminate(), 30_000)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'begin', username })))
    ws.on('message', (data, binary) => {
      if (binary) {
        return
      }
      const message = JSON.parse(data.toString())
      if (message.type === 'prompt') {
        answeredAt = performance.now()
        ws.send(JSON.stringify({ type: 'answer', text: password }))
      } else if (message.type === 'result') {
        const seconds = ((performance.now() - answeredAt) / 1000).toFixed(3)
        result = { outcome: message.ok ? 'ok' : 'fail', seconds, message: message.ok ? message.username : message.message }
        if (message.ok) {
          clearTimeout(timer)
          ws.close()
          resolve({ ...result, code: 0 })
        }
      }
    })
    ws.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ...(result ?? { outcome: 'closed', seconds: '0', message: '' }), code })
    })
  })
}

async function main() {
  if (mode === 'signin') {
    const { outcome, seconds, code, message } = await signIn(a, b)
    console.log(outcome, seconds, code, message)
  } else if (mode === 'failures') {
    const attempts = Array.from({ length: Number(b) }, (_, i) => signIn(a, `wrong-password-${i}`))
    for (const { message } of await Promise.all(attempts)) {
      console.log(message)
    }
  } else if (mode === 'raw') {
    const ws = open()
    ws.on('open', () => (a === '--binary' ? ws.send(Buffer.from([1, 2, 3])) : ws.send(a)))
    console.log(await Promise.race([new Promise((resolve) => ws.on('close', resolve)), sleep(5000).then(() => 'open')]))
  }
  process.exit(0)
}
main()
