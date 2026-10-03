/**
 * Server-rendered error pages; the sign-in form, session list and desktop are one page (the viewer's). No inline
 * scripts or styles (the CSP forbids them), no product or version names.
 */
export function escapeHTML(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

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
<div class="page">
${body}
</div>
</body>
</html>`
}

export function errorPage(status: number): string {
  const text = status === 404 ? 'Not found' : status === 403 ? 'Forbidden' : 'Something went wrong'
  return layout(text, `<main class="card"><h1>${escapeHTML(text)}</h1><p class="subtitle"><a href="/">Back</a></p></main>`)
}
