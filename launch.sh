#!/bin/sh
# Launch pi-config-gui straight from a source clone (Linux/macOS).
# Builds on first run; subsequent runs rebuild only if dist is missing.
# Any arguments are passed through to the CLI.
#   Example:  ./launch.sh --agent-dir ~/.pi/agent --port 8710
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
    echo "Node.js 20 or newer is required but was not found on your PATH." >&2
    echo "Install it from https://nodejs.org and try again." >&2
    exit 1
fi

if [ ! -d node_modules ]; then
    echo "First run: installing dependencies..."
    npm install
fi

if [ ! -f dist/cli.js ]; then
    echo "Building..."
    npm run build
fi

exec node dist/cli.js "$@"
