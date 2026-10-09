import { createRoot } from 'react-dom/client'
import { App } from './app'

/*
 * Entry point: the gateway serves this one page and injects the host name into index.html (into the placeholder in
 * #hostname, see packages/gatekeeper/web); everything else is rendered by React.
 */

// the host name shown on the sign-in form without needing a request
const hostname = document.getElementById('hostname')?.textContent ?? ''
const testMode = new URLSearchParams(location.search).get('test') === '1'

// the browser's own context menu never shows, except on text fields (to paste); our right clicks are handled where they
// happen, and the desktop forwards them to the apps
document.addEventListener('contextmenu', (event) => {
  const target = event.target
  const editable =
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLInputElement && !['button', 'checkbox', 'radio', 'submit', 'reset'].includes(target.type)) ||
    (target instanceof HTMLElement && target.isContentEditable)
  if (!editable) {
    event.preventDefault()
  }
})

createRoot(document.getElementById('root')!).render(<App hostname={hostname} testMode={testMode} />)
