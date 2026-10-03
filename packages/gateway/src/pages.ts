/**
 * Server-rendered pages. No inline scripts or styles (the CSP forbids them), no product or version names.
 */
import { SessionInfo } from './ipc'

export function escapeHTML(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

const userIcon = `<svg width="32" height="32" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Zm0 1.5c-4.1 0-7.5 2.2-7.5 5v1.5h15V18.5c0-2.8-3.4-5-7.5-5Z"/></svg>`

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${escapeHTML(title)}</title>
<link rel="icon" href="/static/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/theme.css">
</head>
<body>
${body}
</body>
</html>`
}

export function loginPage({
  hostname,
  csrf,
  username,
  error,
}: {
  hostname: string | undefined
  csrf: string
  username?: string
  error?: string
}): string {
  return layout(
    'Sign in',
    `<main class="card">
  <div class="avatar">${userIcon}</div>
  <h1>Sign in</h1>
  <p class="subtitle">${hostname ? escapeHTML(hostname) : '&nbsp;'}</p>
  ${error ? `<p class="error" role="alert">${escapeHTML(error)}</p>` : ''}
  <form method="post" action="/login" autocomplete="on">
    <input type="hidden" name="csrf" value="${escapeHTML(csrf)}">
    <label for="username">Username</label>
    <input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false"
      required maxlength="64" value="${escapeHTML(username ?? '')}"${username ? '' : ' autofocus'}>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024"${
      username ? ' autofocus' : ''
    }>
    <button class="primary full" type="submit">Sign in</button>
  </form>
</main>`,
  )
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

export function sessionsPage({
  username,
  hostname,
  csrf,
  sessions,
  error,
}: {
  username: string
  hostname: string | undefined
  csrf: string
  sessions: SessionInfo[]
  error?: string
}): string {
  const list =
    sessions.length === 0
      ? `<p class="empty">You have no running sessions.</p>`
      : `<ul class="sessions">${sessions
          .sort((a, b) => a.createdAt - b.createdAt)
          .map(
            (session, index) => `
    <li>
      <span class="name">Session ${index + 1}<span class="when">Started ${formatTime(session.createdAt)}</span></span>
      <a class="button primary" href="/desktop/?session=${encodeURIComponent(session.id)}">Open</a>
      <form class="inline" method="post" action="/sessions/end">
        <input type="hidden" name="csrf" value="${escapeHTML(csrf)}">
        <input type="hidden" name="session" value="${escapeHTML(session.id)}">
        <button type="submit">End</button>
      </form>
    </li>`,
          )
          .join('')}
  </ul>`
  return layout(
    'Sessions',
    `<main class="card wide">
  <h1>Welcome, ${escapeHTML(username)}</h1>
  <p class="subtitle">${hostname ? escapeHTML(hostname) : '&nbsp;'}</p>
  ${error ? `<p class="error" role="alert">${escapeHTML(error)}</p>` : ''}
  ${list}
  <div class="row">
    <form class="inline" method="post" action="/logout">
      <input type="hidden" name="csrf" value="${escapeHTML(csrf)}">
      <button class="link-button" type="submit">Sign out</button>
    </form>
    <form class="inline" method="post" action="/sessions/new">
      <input type="hidden" name="csrf" value="${escapeHTML(csrf)}">
      <button class="primary" type="submit">Start new session</button>
    </form>
  </div>
</main>`,
  )
}

export function errorPage(status: number): string {
  const text = status === 404 ? 'Not found' : status === 403 ? 'Forbidden' : 'Something went wrong'
  return layout(text, `<main class="card"><h1>${escapeHTML(text)}</h1><p class="subtitle"><a href="/">Back</a></p></main>`)
}
