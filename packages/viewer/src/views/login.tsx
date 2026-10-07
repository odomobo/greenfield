import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { appStore } from '../state'
import { useStore } from '../store'

/**
 * The sign-in form. Like unlocking a screen: the sign-in lasts as long as the page's WebSocket (see connection.ts).
 * The username and password are asked up front (so password managers work); the password answers the server's
 * first hidden prompt. Any further prompt of the server's (PAM's, e.g. a one-time code) replaces the fields with one
 * of its own until it's answered. The inputs are uncontrolled, so the submit handlers read what's in them.
 */
export function LoginView({
  hostname,
  onSubmit,
  onAnswer,
  usernameRef,
  passwordRef,
}: {
  hostname: string
  onSubmit: (username: string, password: string) => void
  onAnswer: (answer: string) => void
  usernameRef: RefObject<HTMLInputElement>
  passwordRef: RefObject<HTMLInputElement>
}) {
  const view = useStore(appStore)
  const visible = view.view === 'login'
  const prompt = view.loginPrompt
  const answerRef = useRef<HTMLInputElement>(null)

  // shown (or re-shown after a failed sign-in, which also cleared the password): focus the field to type in
  useEffect(() => {
    if (!visible) {
      return
    }
    if (prompt !== undefined) {
      answerRef.current?.focus()
      return
    }
    const username = usernameRef.current
    const password = passwordRef.current
    if (username !== null && password !== null) {
      ;(username.value ? password : username).focus()
    }
  }, [visible, prompt, view.loginFocusNonce, usernameRef, passwordRef])

  return (
    <div id="login-view" className="page" hidden={!visible}>
      <main className="card">
        <img className="logo" src="/static/logo.png" alt="" draggable={false} />
        <h1>Sign in</h1>
        <p className="subtitle">{hostname}</p>
        <p className="error" role="alert" hidden={view.loginError === undefined}>
          {view.loginError}
        </p>
        <p className="subtitle" id="login-info" role="status" hidden={view.loginInfo === undefined}>
          {view.loginInfo}
        </p>
        <form
          id="login-form"
          method="post"
          autoComplete="on"
          hidden={prompt !== undefined}
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
        {prompt !== undefined && (
          <form
            id="prompt-form"
            autoComplete="off"
            onSubmit={(event) => {
              event.preventDefault()
              const input = answerRef.current
              onAnswer(input?.value ?? '')
              // a further prompt starts empty
              if (input !== null) {
                input.value = ''
              }
            }}
          >
            <label htmlFor="prompt-answer">{prompt.text}</label>
            <input
              id="prompt-answer"
              type={prompt.echo ? 'text' : 'password'}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={1024}
              ref={answerRef}
            />
            <button className="primary full" type="submit" id="prompt-submit" disabled={view.loginBusy}>
              Continue
            </button>
          </form>
        )}
      </main>
    </div>
  )
}
