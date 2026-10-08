#!/usr/bin/env bash
# End-to-end test of changing an expired password in the browser: the page's side of the conversation nebula-login
# relays from pam_chauthtok. Starts the gateway (the dev login helper, see lib.sh) with
# --dev-expired-password, which makes every sign-in find the password expired and ask for a new one with pam_unix's
# prompts and messages, then checks in a headless browser (scripts/e2e/browser-driver.js):
#   1. after the form's password, the page shows the expiry notice and "Changing password for <user>." and asks for
#      the current password in a field of its own (#prompt-form, focused); a wrong one is refused with the "not
#      changed" message, and the sign-in form is back;
#   2. new passwords that don't match: the mismatch error shows with the repeated "New password:" prompt (the earlier
#      messages are gone); matching ones sign in, and the desktop shows.
# The policy checks and the real pam_chauthtok call are unit-tested in packages/gatekeeper (they need PAM and root).
#
# Requires: dbus-daemon, playwright-cli (for its Playwright library and browser), curl, node, the built packages
# (make). Usage: scripts/e2e/password.sh   (GATEWAY_PORT)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_tools dbus-daemon playwright-cli curl node

mkdir -p "$WORK/data" "$WORK/config"
read -r DBUS_ADDRESS DBUS_PID < <(dbus-daemon --session --fork --nopidfile --print-address=1 --print-pid=1 | tr '\n' ' '; echo)
[ -n "$DBUS_PID" ] || fail "couldn't start a D-Bus session bus"
export DBUS_SESSION_BUS_ADDRESS="$DBUS_ADDRESS"

step "starting the gateway on :$PORT (passwords expired) and the browser"
curl -sk -o /dev/null "$BASE/" && fail "port $PORT is already in use"
start_gateway "$PORT" "$WORK/gateway.log" --dev-expired-password
GATEWAY_PID="$STARTED_PID"
start_driver
pw open "$BASE/?test=1" >/dev/null

# Submit the sign-in form (username and password), with a real click
submit_form() {
  wait_for "() => $(visible login-view) && !!document.querySelector('#password') && !document.querySelector('#login-submit').disabled" "the sign-in form"
  pw_eval "() => { document.querySelector('#username').value = '$ME'; document.querySelector('#password').value = '$PASSWORD'; return true }" >/dev/null
  click_element '#login-submit'
}
# The page's text of an element ('' if hidden), for checks
shown() { echo "(document.querySelector('$1')?.hidden === false ? document.querySelector('$1').textContent : '')"; }
# Wait for the prompt labelled $1 (focused, ready to type in), with the error and info texts containing $2 and $3
wait_prompt() {
  wait_for "() => document.querySelector('#prompt-form label')?.textContent.trim() === '$1' && document.activeElement?.id === 'prompt-answer' && !document.querySelector('#prompt-submit').disabled && $(shown '#login-view .error').includes('$2') && $(shown '#login-info').includes('$3') && document.querySelector('#login-form').hidden" "the prompt \"$1\"" 10
}
# Type an answer into the prompt and press Enter
answer() {
  pw type "$1" >/dev/null
  pw press Enter >/dev/null
}

step "a wrong current password is refused; the sign-in form is back"
submit_form
wait_prompt "Current password:" "required to change your password" "Changing password for $ME."
answer "not-the-password"
wait_for "() => $(visible login-view) && !document.querySelector('#prompt-form') && !document.querySelector('#login-form').hidden && $(shown '#login-view .error') === 'The password has expired and was not changed.'" "the refusal" 10
echo "    ok"

step "the new passwords don't match, then they do: signed in"
submit_form
wait_prompt "Current password:" "required to change your password" "Changing password for $ME."
answer "$PASSWORD"
# the messages that came with the previous prompt are gone
wait_prompt "New password:" "" ""
[ "$(pw_eval "() => $(shown '#login-view .error') + $(shown '#login-info')")" = '""' ] || fail "earlier messages still show"
answer "new-password-1"
wait_prompt "Retype new password:" "" ""
answer "new-password-2"
wait_prompt "New password:" "Sorry, passwords do not match." ""
answer "new-password-3"
wait_prompt "Retype new password:" "" ""
answer "new-password-3"
wait_for "() => $(visible desktop-view) && window.__viewerTest.connected()" "the desktop" 40
grep -q "Changed the (dev) expired password" "$WORK/gateway.log" || fail "the helper didn't log the change"
echo "    ok"

echo "PASS: changing an expired password in the browser: the prompts and messages show, a refusal, a mismatch, signed in"
