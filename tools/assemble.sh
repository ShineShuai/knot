#!/usr/bin/env bash
# Assemble the deployable site (only what the browser needs) for one channel.
#   tools/assemble.sh <out-dir> <commit-sha> <beta|prod>
# beta: GitHub Pages (test copy).  prod: Cloudflare (adds deploy/cloudflare/_headers).
# The two bundles differ only in the channel stamp and the manifest name (see the test).
# Deterministic: the same commit and channel always give the same bytes.
set -euo pipefail

usage() { echo "usage: ${0##*/} <out-dir> <commit-sha> <beta|prod>" >&2; exit 2; }
[[ $# -eq 3 ]] || usage
out=$1 sha=$2 channel=$3
[[ $sha =~ ^[0-9a-f]{7,40}$ ]] || { echo "not a commit id: $sha" >&2; usage; }
[[ $channel == beta || $channel == prod ]] || { echo "unknown channel: $channel" >&2; usage; }
[[ ! -e $out ]] || { echo "$out exists; remove it first" >&2; exit 1; }

root=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$out"
cp -R "$root"/{index.html,sw.js,manifest.webmanifest,css,icons,lab,src} "$out/"

# sed -i differs between GNU and BSD (macOS); a temp file works on both.
stamp() { # <file> <sed-expression>
  sed "$2" "$1" > "$1.tmp" && mv "$1.tmp" "$1"
}

# Lets open pages notice a newer deploy (src/update.js) and tells beta from prod (src/build.js).
meta() { printf '<meta name="%s" content="%s">' "$1" "$2"; }
stamp "$out/index.html" "s|$(meta build '')|$(meta build "$sha")|"
stamp "$out/index.html" "s|$(meta channel dev)|$(meta channel "$channel")|"
grep -qF "$(meta build "$sha")" "$out/index.html"
grep -qF "$(meta channel "$channel")" "$out/index.html"
printf '{"build":"%s"}\n' "$sha" > "$out/build.json"

case $channel in
  beta) # two installed copies must be told apart on a home screen
    stamp "$out/manifest.webmanifest" \
      's|"name": "knot - |"name": "knot β - |;s|"short_name": "knot"|"short_name": "knot β"|'
    grep -q '"short_name": "knot β"' "$out/manifest.webmanifest"
    touch "$out/.nojekyll"
    ;;
  prod)
    cp "$root/deploy/cloudflare/_headers" "$out/_headers"
    ;;
esac
echo "assembled $channel $sha in $out"
