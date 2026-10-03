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
- Known violation: `scripts/test-gateway.sh` takes several minutes. It needs this refactoring.
