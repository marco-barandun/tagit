#!/bin/bash
# Double-click this file to run tagit in your browser.
# It serves the docs/ folder on http://localhost and opens your browser there.
# Close this Terminal window (or press Ctrl+C) to stop the server.

cd "$(dirname "$0")" || { echo "Could not find the tagit folder."; exit 1; }

PORT=8777
URL="http://localhost:$PORT/"

echo "Starting tagit at $URL"
echo "Leave this window open while you work. Close it to stop."
echo

# Open the browser once the server has had a moment to start.
( sleep 1; open "$URL" ) &

# python3 ships with macOS; serve.py disables caching so every reload always
# picks up the latest files (plain `http.server` can silently serve stale
# pages on a normal refresh).
exec python3 serve.py "$PORT"
