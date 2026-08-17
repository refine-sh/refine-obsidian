#!/bin/sh

set -u

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
diagnostics=$(mktemp "${TMPDIR:-/tmp}/refine-obsidian-conformance.XXXXXX") || exit 1

cleanup() {
  /bin/rm -f "$diagnostics"
}
trap cleanup EXIT HUP INT TERM

status=0
node "$script_directory/run-client.mjs" "$@" 2>"$diagnostics" || status=$?
if [ "$status" -eq 0 ]; then
  exit 0
fi

/bin/cat "$diagnostics" >&2
exit "$status"
