#!/usr/bin/env bash
# Launch CastOS full screen on a TV or Raspberry Pi.
#
# Chromium blocks audio until the page gets a click. These flags lift that
# rule for a dedicated screen, enable full screen and stop the screensaver /
# infobar from appearing:
#
#   tools/kiosk.sh http://localhost:8080/
#
# YouTube's TV interface (youtube.com/tv) only appears for a smart-TV user
# agent. A page cannot change the User-Agent of a navigation — browsers treat
# it as a forbidden header — so it is set here, for the browser session.
# Override it with TV_UA="..." tools/kiosk.sh.
set -euo pipefail

URL="${1:-http://localhost:8080/}"

TV_UA="${TV_UA:-Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/2.0 Chrome/63.0.3239.84 TV Safari/537.36}"

for browser in chromium chromium-browser google-chrome google-chrome-stable; do
  if command -v "$browser" >/dev/null 2>&1; then
    exec "$browser" \
      --kiosk \
      --user-agent="$TV_UA" \
      --autoplay-policy=no-user-gesture-required \
      --noerrdialogs \
      --disable-infobars \
      --disable-session-crashed-bubble \
      "$URL"
  fi
done

echo "No Chromium-based browser found (chromium, chromium-browser, google-chrome)." >&2
exit 1
