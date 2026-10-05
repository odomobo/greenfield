import { useEffect } from 'react'
import type { RefObject } from 'react'
import { appStore } from '../state'
import { useStore } from '../store'

/**
 * The sign-in form. Like unlocking a screen: the token it produces lives only in this page (see auth.ts). The
 * inputs are uncontrolled, so the submit handler reads what's in them.
 */
export function LoginView({
  hostname,
  onSubmit,
  usernameRef,
  passwordRef,
}: {
  hostname: string
  onSubmit: (username: string, password: string) => void
  usernameRef: RefObject<HTMLInputElement>
  passwordRef: RefObject<HTMLInputElement>
}) {
  const view = useStore(appStore)
  const visible = view.view === 'login'

  // shown (or re-shown after a failed sign-in, which also cleared the password): focus the field to type in
  useEffect(() => {
    if (visible) {
      const username = usernameRef.current
      const password = passwordRef.current
      if (username !== null && password !== null) {
        ;(username.value ? password : username).focus()
      }
    }
  }, [visible, view.loginFocusNonce, usernameRef, passwordRef])

  return (
    <div id="login-view" className="page" hidden={!visible}>
      <main className="card">
        <img className="logo" src="/static/logo.png" alt="" draggable={false} />
        <h1>Sign in</h1>
        <p className="subtitle">{hostname}</p>
        <p className="error" role="alert" hidden={view.loginError === undefined}>
          {view.loginError}
        </p>
        <form
          id="login-form"
          method="post"
          autoComplete="on"
          onSubmit={(event) => {
            event.preventDefault()
            onSubmit(usernameRef.current?.value ?? '', passwordRef.current?.value ?? '')
          }}
        >
          <label htmlFor="username">Username</label>
          <input
            id="username"
            name="username"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            maxLength={64}
            ref={usernameRef}
          />
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={1024}
            ref={passwordRef}
          />
          <button className="primary full" type="submit" id="login-submit" disabled={view.loginBusy}>
            Sign in
          </button>
        </form>
      </main>
    </div>
  )
}
