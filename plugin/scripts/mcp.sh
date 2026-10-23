#!/bin/sh
# Start the FrameVelo MCP server on stdio: an installed `framevelo` when there is one (starts at
# once), otherwise the GitHub version through npx (about half a minute the first time, then cached).
if command -v framevelo >/dev/null 2>&1; then
  exec framevelo mcp
fi
# The HyperFrames packages depend on puppeteer, whose install would download a Chrome FrameVelo
# does not use.
export PUPPETEER_SKIP_DOWNLOAD=true
exec npx -y -p github:gnipbao/framevelo -p @hyperframes/producer@0.8.186 -p @hyperframes/engine@0.8.186 framevelo mcp
