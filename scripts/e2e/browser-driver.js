// A small headless-browser server for the end-to-end scripts, built on the Playwright library that ships with
// playwright-cli. playwright-cli itself spends a fixed second of every command waiting for the page to settle, which
// made the end-to-end test take minutes; this keeps one browser open and answers commands over local HTTP in
// milliseconds. The scripts talk to it through `pw` (see lib.sh): POST /<command> with the arguments as the body.
//
// Usage: node browser-driver.js <port-file>     (prints nothing; writes the port it listens on into <port-file>)
//
// Commands (body = arguments):
//   open <url>            start a fresh browser (closing any earlier one), HTTPS errors ignored, 1280x800 viewport
//   close                 close the browser
//   eval <function>       evaluate a function expression in the page, answer its result as JSON
//   mousemove x y | mousedown [right] | mouseup [right] | wheel dx dy | type <text> | press <key> | keydown <key> | keyup <key>
//   | resize w h
//   scale <ratio>         change the page's devicePixelRatio (like moving the window to another monitor)
//   cdpclick <back|forward> x y   press and release a mouse button Playwright's API doesn't have
//   tab-new | goto <url> | tab-close | tab-select <index>
//   dialog                answer the text of the pending dialog ("beforeunload: ..."), or nothing
//   dialog-accept | dialog-dismiss
const fs = require('fs')
const http = require('http')
const path = require('path')
const { execFileSync } = require('child_process')

function loadPlaywright() {
  try {
    return require('playwright')
  } catch {}
  const cli = fs.realpathSync(execFileSync('sh', ['-c', 'command -v playwright-cli'], { encoding: 'utf8' }).trim())
  return require(path.join(path.dirname(cli), 'node_modules', 'playwright'))
}
const { chromium } = loadPlaywright()

let browser
let context
let pages = []
let current
let dialog
const scaleSessions = new Map()

function adopt(page) {
  pages.push(page)
  current = page
  page.on('dialog', (d) => {
    dialog = d
  })
  page.on('close', () => {
    pages = pages.filter((p) => p !== page)
    if (current === page) current = pages[0]
  })
}

async function launch() {
  const options = { headless: true }
  try {
    return await chromium.launch({ ...options, channel: 'chrome' })
  } catch {
    return await chromium.launch(options)
  }
}

const commands = {
  async open(url) {
    if (browser) await browser.close().catch(() => {})
    browser = await launch()
    context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } })
    // the clipboard tests read and write the page's clipboard (the browser would ask the user otherwise)
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    pages = []
    dialog = undefined
    adopt(await context.newPage())
    await current.goto(url)
  },
  async close() {
    if (browser) await browser.close().catch(() => {})
    browser = undefined
    pages = []
    current = undefined
  },
  async eval(expression) {
    const result = await current.evaluate(`(${expression})()`)
    return result === undefined ? '' : JSON.stringify(result)
  },
  async mousemove(args) {
    const [x, y] = args.split(' ').map(Number)
    await current.mouse.move(x, y)
  },
  async mousedown(args) {
    await current.mouse.down({ button: args === 'right' ? 'right' : 'left' })
  },
  async wheel(args) {
    const [dx, dy] = args.split(' ').map(Number)
    await current.mouse.wheel(dx, dy)
  },
  async mouseup(args) {
    await current.mouse.up({ button: args === 'right' ? 'right' : 'left' })
  },
  async type(text) {
    await current.keyboard.type(text)
  },
  async press(key) {
    await current.keyboard.press(key)
  },
  async keydown(key) {
    await current.keyboard.down(key)
  },
  async keyup(key) {
    await current.keyboard.up(key)
  },
  /** a PNG of the page, for looking at a failure: screenshot <file> */
  async screenshot(file) {
    await current.screenshot({ path: file })
  },
  async resize(args) {
    const [width, height] = args.split(' ').map(Number)
    await current.setViewportSize({ width, height })
  },
  /** change the device pixel ratio of the open page, as moving the window to another monitor does: scale <ratio> */
  async scale(ratio) {
    // the override lasts as long as its session: keep it (one per page)
    if (!scaleSessions.has(current)) scaleSessions.set(current, await context.newCDPSession(current))
    const cdp = scaleSessions.get(current)
    const { width, height } = current.viewportSize()
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: Number(ratio),
      mobile: false,
    })
    // a real browser fires resize when the ratio changes; the emulation doesn't (nor the media query)
    await current.evaluate(() => window.dispatchEvent(new Event('resize')))
  },
  async cdpclick(args) {
    const [button, x, y] = args.split(' ')
    const cdp = await context.newCDPSession(current)
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {
        type,
        x: Number(x),
        y: Number(y),
        button,
        buttons: type === 'mousePressed' ? (button === 'back' ? 8 : 16) : 0,
        clickCount: 1,
      })
    }
    await cdp.detach()
  },
  async 'tab-new'() {
    adopt(await context.newPage())
  },
  async goto(url) {
    await current.goto(url)
  },
  async 'tab-close'() {
    await current.close()
  },
  async 'tab-select'(index) {
    current = pages[Number(index)]
    await current.bringToFront()
  },
  async dialog() {
    return dialog ? `${dialog.type()}: ${dialog.message()}` : ''
  },
  async 'dialog-accept'() {
    const d = dialog
    dialog = undefined
    await d.accept()
  },
  async 'dialog-dismiss'() {
    const d = dialog
    dialog = undefined
    await d.dismiss()
  },
}

const server = http.createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const command = request.url.slice(1)
  const body = Buffer.concat(chunks).toString('utf8')
  try {
    if (!commands[command]) throw new Error(`unknown command ${command}`)
    const answer = (await commands[command](body)) ?? ''
    response.writeHead(200)
    response.end(answer)
  } catch (e) {
    response.writeHead(500)
    response.end(`${command} failed: ${e.message}`)
  }
})
server.listen(0, '127.0.0.1', () => fs.writeFileSync(process.argv[2], String(server.address().port)))

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    if (browser) await browser.close().catch(() => {})
    process.exit(0)
  })
}
