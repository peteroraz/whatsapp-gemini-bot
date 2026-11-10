#!/bin/sh
set -eu
umask 077
mkdir -p "$DATA_DIR"
# Same local volume => one WhatsApp session. The kernel releases this lock on exit.
# Recover browser locks only AFTER excluding another bot on this volume.
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec flock --exclusive --nonblock --conflict-exit-code 75 --no-fork "$DATA_DIR/instance.lock" \
    sh -c 'node "$1" && shift && exec "$@"' sh "$script_dir/prepare-profile.js" "$@"
