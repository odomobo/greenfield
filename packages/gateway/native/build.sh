#!/bin/sh
# Builds the privileged PAM helper. Needs the PAM development headers (Debian/Ubuntu: libpam0g-dev,
# Fedora: pam-devel). PAM_CFLAGS can point at headers elsewhere, e.g. PAM_CFLAGS=-I/path/to/include.
set -e
cd "$(dirname "$0")/.."
mkdir -p dist
if ! echo '#include <security/pam_appl.h>' | ${CC:-cc} ${PAM_CFLAGS} -E - >/dev/null 2>&1; then
  echo "gateway: PAM headers not found (install libpam0g-dev / pam-devel). Skipping pam-helper; only --dev-auth will work." >&2
  exit 0
fi
${CC:-cc} -O2 -Wall -Wextra -D_FORTIFY_SOURCE=2 -fstack-protector-strong ${PAM_CFLAGS} \
  -o dist/pam-helper native/pam-helper.c -l:libpam.so.0
echo "gateway: built dist/pam-helper"
