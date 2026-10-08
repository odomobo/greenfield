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
- The end-to-end suite, `scripts/test-gateway.sh`, runs all the scripts in `scripts/e2e/` in parallel (each with its
  own gateway, ports and browser; about 30 s) and prints how long each took, slowest first. **The whole parallel run
  must stay under one minute.** If it goes over (the runner prints "SLOW: ..."), the suite needs an optimization and
  refactoring pass, starting with the slowest scripts, before more checks are added.
- Its gateways are the dev login helper (`nebula-dev-login`) run with `--dev-time-scale 3`, which shortens the sign-in
  delays (test only); the browser is driven by `scripts/e2e/browser-driver.js` rather than `playwright-cli` (which
  waits a fixed second after every command). New e2e checks go into one of those scripts (or a new script added to the runner), and wait on conditions
  with `wait_for` / `wait_until` from `scripts/e2e/lib.sh`, never fixed sleeps.
- The scripts share the machine, so a check must not depend on how fast things happen (the suite was flaky until
  2026-10-05 from exactly this):
  - aim pointer actions at page elements with `element_center` / `settled_rect` (lib.sh: they wait until the element
    stops moving and isn't covered), and at window coordinates only after `wait_windows_still` (windows scale in when
    they open);
  - wait for the state you act on, not one that precedes it (the viewer's window list changes before the taskbar
    re-renders; a new window takes the keyboard focus, so type a whole command line before anything opens a window);
  - measure layout only once it's still; compare wall-clock times only with wide margins, or check a difference twice
    before failing (a real leak shows every time, load only now and then).

## Never kill processes by name

- Don't use `pkill`, `killall` or anything else that matches processes by name or command line (`pkill -f`,
  `pkill -x foot`, ...). The user runs their own apps, gateways and sessions on this machine, and a name match kills
  those too.
- Kill only processes you started, by the PID you recorded when starting them (`$!` in shell, `child.pid` in Node),
  or by stopping the process group you created.
