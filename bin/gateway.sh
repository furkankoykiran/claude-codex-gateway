#!/bin/bash
set -e

SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$( cd -P "$( dirname "$SOURCE" )" && pwd )"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
DIR="$( cd -P "$( dirname "$SOURCE" )" && pwd )"
ROOT_DIR="$(dirname "$DIR")"
SRC_FILE="$ROOT_DIR/src/index.ts"
VERSION="0.1.3"

STATE_DIR="${CODEX_GATEWAY_STATE_DIR:-$HOME/.claude-codex-gateway}"
umask 077
mkdir -p "$STATE_DIR"
PID_FILE="$STATE_DIR/gateway.pid"
LOG_FILE="$STATE_DIR/gateway.log"
BUN_BIN="$(command -v bun || echo bun)"

owns_process() {
  case "$PID" in ''|*[!0-9]*) return 1 ;; esac
  local command_line
  command_line=$(ps -p "$PID" -o args= 2>/dev/null) || return 1
  [ "$command_line" = "$BUN_BIN $SRC_FILE serve" ]
}

case "$1" in
  start)
    if [ -f "$PID_FILE" ]; then
      PID=$(cat "$PID_FILE")
      if ps -p "$PID" > /dev/null 2>&1; then
        owns_process || { echo "PID belongs to another process; refusing reuse."; exit 1; }
        echo "Gateway is already running (pid $PID)."
        exit 0
      else
        echo "Removing stale pid file."
        rm -f "$PID_FILE"
      fi
    fi
    echo "Starting gateway..."
    nohup "$BUN_BIN" "$SRC_FILE" serve > "$LOG_FILE" 2>&1 &
    PID=$!
    echo "$PID" > "$PID_FILE"
    echo "Gateway started (pid $PID)."
    ;;
  stop)
    if [ ! -f "$PID_FILE" ]; then
      echo "Gateway is not running."
      exit 0
    fi
    PID=$(cat "$PID_FILE")
    if ps -p "$PID" > /dev/null 2>&1; then
      owns_process || { echo "PID belongs to another process; refusing stop."; exit 1; }
      echo "Stopping gateway (pid $PID)..."
      kill "$PID" 2>/dev/null || true
    else
      echo "Gateway is not running (stale pid)."
    fi
    rm -f "$PID_FILE"
    echo "Gateway stopped."
    ;;
  status)
    if [ -f "$PID_FILE" ]; then
      PID=$(cat "$PID_FILE")
      if ps -p "$PID" > /dev/null 2>&1; then
        owns_process || { echo "PID belongs to another process; refusing status."; exit 1; }
        echo "Gateway is running (pid $PID)."
        exit 0
      else
        echo "Gateway is not running (stale pid file)."
        rm -f "$PID_FILE"
        exit 1
      fi
    else
      echo "Gateway is not running."
      exit 1
    fi
    ;;
  doctor)
    echo "Checking gateway environment..."
    if ! command -v bun >/dev/null 2>&1; then
      echo "❌ bun is not installed or not in PATH."
      exit 1
    fi
    "$BUN_BIN" "$SRC_FILE" doctor
    ;;
  version)
    echo "claude-codex-gateway v$VERSION"
    ;;
  *)
    echo "Usage: $0 {start|stop|status|doctor|version}"
    exit 1
    ;;
esac
