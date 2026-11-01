#!/usr/bin/env bash
# Shape this Mac's UDP traffic (WebRTC media) to see how a call copes with a bad network.
# macOS only (dummynet + pf); needs root; DNS (UDP 53) is left alone.
#
#   sudo tools/netshape.sh good|lte|weak|lossy|hopeless   apply a profile
#   sudo tools/netshape.sh cycle                          good -> weak -> hopeless -> good, loop
#   sudo tools/netshape.sh status                         show the active pipes and rules
#   sudo tools/netshape.sh off                            restore (also done when `cycle` ends)
#
# Profiles (uplink kbit/s, downlink kbit/s, one-way delay ms, packet loss):
#   good 10000/10000, 20 ms, 0 %      lte 1500/5000, 60 ms, 0.5 %    weak 400/1500, 120 ms, 1 %
#   lossy 2000/2000, 60 ms, 5 %       hopeless 60/200, 250 ms, 3 %
# Watch the result in Settings > Diagnostics (one line per call connection) and in the call.
# Not run on every macOS version: if a rule is refused, `off` restores /etc/pf.conf.
set -euo pipefail

ANCHOR=knot
UP=11 DOWN=12
TOKEN=/tmp/knot-netshape.token

profile() { # uplink downlink delay loss
  case "$1" in
    good) echo "10000 10000 20 0" ;;
    lte) echo "1500 5000 60 0.005" ;;
    weak) echo "400 1500 120 0.01" ;;
    lossy) echo "2000 2000 60 0.05" ;;
    hopeless) echo "60 200 250 0.03" ;;
    *) return 1 ;;
  esac
}

apply() {
  read -r up down delay loss < <(profile "$1") || { echo "unknown profile: $1" >&2; exit 2; }
  dnctl pipe "$UP" config bw "${up}Kbit/s" delay "$delay" plr "$loss" queue 20
  dnctl pipe "$DOWN" config bw "${down}Kbit/s" delay "$delay" plr "$loss" queue 20
  { cat /etc/pf.conf; printf 'dummynet-anchor "%s"\nanchor "%s"\n' "$ANCHOR" "$ANCHOR"; } \
    | pfctl -q -f -
  printf '%s\n' \
    "dummynet out proto udp from any to any port != 53 pipe $UP" \
    "dummynet in proto udp from any port != 53 to any pipe $DOWN" \
    | pfctl -q -a "$ANCHOR" -f -
  if [[ ! -f $TOKEN ]]; then pfctl -E 2>&1 | sed -n 's/^Token *: *//p' > "$TOKEN"; fi
  echo "shaping: $1 (up ${up} kbit/s, down ${down} kbit/s, ${delay} ms, loss ${loss})"
}

off() {
  pfctl -q -f /etc/pf.conf || true
  dnctl -q flush || true
  if [[ -s $TOKEN ]]; then pfctl -q -X "$(cat "$TOKEN")" || true; fi
  rm -f "$TOKEN"
  echo "shaping: off"
}

[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
case "${1:-}" in
  good | lte | weak | lossy | hopeless) apply "$1" ;;
  cycle)
    trap 'off; exit 0' INT TERM EXIT
    while true; do
      apply good; sleep 60
      apply weak; sleep 60
      apply hopeless; sleep 30
      apply good; sleep 90
    done ;;
  status) dnctl list; pfctl -a "$ANCHOR" -sr ;;
  off) off ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
