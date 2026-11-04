#!/bin/sh
set -e

# Agar CHROME_PATH galat hai to actual chrome binary dhoondo
if [ ! -x "$CHROME_PATH" ]; then
  FOUND=$(find /opt/ms-playwright -type f \( -name chrome -o -name headless_shell \) 2>/dev/null | grep -v headless_shell | head -n1 || true)
  if [ -z "$FOUND" ]; then
    FOUND=$(find /opt/ms-playwright -type f -name headless_shell 2>/dev/null | head -n1 || true)
  fi
  if [ -n "$FOUND" ]; then
    export CHROME_PATH="$FOUND"
  fi
fi

echo "[start.sh] CHROME_PATH=$CHROME_PATH"
echo "[start.sh] starting server on PORT=$PORT"
exec node server.js
