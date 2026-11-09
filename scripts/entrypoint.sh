#!/bin/sh
set -eu
umask 077
mkdir -p "$DATA_DIR"
# Same local volume => one WhatsApp session. The kernel releases this lock on exit.
exec flock --exclusive --nonblock --conflict-exit-code 75 --no-fork "$DATA_DIR/instance.lock" "$@"
