import { createRoot } from 'react-dom/client'
import { App } from './app'

/*
 * Entry point: the gateway serves this one page and injects the host name into index.html (into the placeholder in
 * #hostname, see packages/gateway/src/web.ts); everything else is rendered by React.
 */

// the host name shown on the sign-in form without needing a request
const hostname = document.getElementById('hostname')?.textContent ?? ''
const testMode = new URLSearchParams(location.search).get('test') === '1'

createRoot(document.getElementById('root')!).render(<App hostname={hostname} testMode={testMode} />)
