#!/usr/bin/env bash
# Wait until a deployed site serves the given commit in build.json (CDNs and Pages lag a little).
#   tools/wait-for-build.sh <site-url> <commit-sha> [timeout-seconds=180]
set -euo pipefail
[[ $# -ge 2 ]] || { echo "usage: ${0##*/} <site-url> <commit-sha> [timeout-seconds]" >&2; exit 2; }
url=${1%/}/build.json sha=$2 deadline=$((SECONDS + ${3:-180}))
while ((SECONDS < deadline)); do
  # A query string and no-cache keep an edge or browser cache out of the answer.
  if curl -fsS -H 'cache-control: no-cache' "$url?t=$SECONDS" 2> /dev/null \
    | grep -q "\"$sha\""; then
    echo "$url serves $sha"
    exit 0
  fi
  sleep 5
done
echo "timeout: $url does not serve $sha" >&2
exit 1
