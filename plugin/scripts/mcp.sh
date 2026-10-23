#!/bin/sh
# Start the FrameVelo MCP server on stdio.
# - An installed `framevelo` (npm install -g github:gnipbao/framevelo ...) starts at once.
# - Otherwise FrameVelo and the HyperFrames packages are installed once into the user's cache, per
#   plugin version, and reused. The first start takes about a minute.
set -u
if command -v framevelo >/dev/null 2>&1; then
  exec framevelo mcp
fi

here=$(cd "$(dirname "$0")" && pwd)
version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$here/../.claude-plugin/plugin.json")
dir="${XDG_CACHE_HOME:-$HOME/.cache}/framevelo/agent-${version:-dev}"
bin="$dir/node_modules/.bin/framevelo"
lock="$dir/.installing"

attempts=0
# Wait while an install runs (this start's or another's); start one when none is running.
while [ -d "$lock" ] || [ ! -x "$bin" ]; do
  if [ ! -x "$bin" ] && mkdir -p "$dir" && mkdir "$lock" 2>/dev/null; then
    if [ "$attempts" -ge 2 ]; then
      rm -rf "$lock"
      echo "framevelo: install failed; see $dir/install.log" >&2
      exit 1
    fi
    attempts=$((attempts + 1))
    echo "framevelo: first start, installing into $dir (about a minute)" >&2
    # Detached, so a client that gives up on the slow first start does not kill the install
    # halfway. The HyperFrames packages depend on puppeteer, whose own Chrome download FrameVelo
    # does not need.
    nohup sh -c '
      cd "$1" && PUPPETEER_SKIP_DOWNLOAD=true npm install --no-fund --no-audit --loglevel=error \
        "${FRAMEVELO_SPEC:-github:gnipbao/framevelo}" @hyperframes/producer@0.8.186 @hyperframes/engine@0.8.186 \
        > install.log 2>&1
      rm -rf "$2"
    ' sh "$dir" "$lock" >/dev/null 2>&1 &
    echo $! > "$lock/pid" 2>/dev/null
  fi
  # An install killed along with its client leaves a stale lock: the next pass retries.
  pid=$(cat "$lock/pid" 2>/dev/null || true)
  if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then rm -rf "$lock"; fi
  sleep 1
done
exec "$bin" mcp
