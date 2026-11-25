#!/bin/sh
# Only the disposable container environment reaches the Codey process.
set -eu
umask 077
mkdir /tmp/codey-home
exec /usr/bin/env -i \
  PATH=/usr/local/bin:/usr/bin:/bin \
  HOME=/tmp/codey-home TMPDIR=/tmp TERM=xterm-256color \
  /opt/codey/codey/bin/codey --offline --no-approve --no-session
