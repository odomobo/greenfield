# Notes for agents

## Tests must be fast

- Any regular test (a unit test file, or a run of an end-to-end script) must finish in under one minute. A test that
  takes longer is a defect in the test, not something to wait out: development slows to a crawl when every change
  needs a multi-minute run.
- Run tests with a timeout that matches this (about two minutes at most). If a run goes past it, stop it and find out
  why instead of rerunning it with a longer timeout.
- Fix slow tests by refactoring them, for example:
  - wait for a condition (an event, a log line, a pixel change) instead of sleeping for a fixed time;
  - make delays that exist for security or pacing (sign-in throttling, timeouts) configurable, and shorten them in tests;
  - start expensive things (gateway, browser, session) once and share them between checks;
  - split a long script into independent, focused scripts that can run on their own or in parallel;
  - move rarely needed slow scenarios into an opt-in suite that isn't part of the regular run.
- If refactoring a slow test is outside the current task, say so in your report rather than silently waiting on it.
- The end-to-end test, `scripts/test-gateway.sh`, runs `scripts/e2e/auth.sh`, `scripts/e2e/desktop.sh` and
  `scripts/e2e/x11.sh` in parallel (about 20-25 s). Its gateways run with `--dev-auth --dev-time-scale 3`, which
  shortens the sign-in delays (test only); the browser is driven by `scripts/e2e/browser-driver.js` rather than
  `playwright-cli` (which waits a fixed second after every command). New e2e checks go into one of those scripts (or
  a new script added to the runner), and wait on conditions with `wait_for` / `wait_until` from `scripts/e2e/lib.sh`,
  never fixed sleeps.

## Never kill processes by name

- Don't use `pkill`, `killall` or anything else that matches processes by name or command line (`pkill -f`,
  `pkill -x foot`, ...). The user runs their own apps, gateways and sessions on this machine, and a name match kills
  those too.
- Kill only processes you started, by the PID you recorded when starting them (`$!` in shell, `child.pid` in Node),
  or by stopping the process group you created.
