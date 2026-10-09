#!/bin/bash
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$(dirname "$DIR")"
PID_FILE="$ROOT_DIR/.gateway.pid"
LOG_FILE="$ROOT_DIR/gateway.log"
SRC_FILE="$ROOT_DIR/src/index.ts"

case "$1" in
  start)
    if [ -f "$PID_FILE" ]; then
      PID=$(cat "$PID_FILE")
      if ps -p $PID > /dev/null 2>&1; then
        echo "Gateway is already running (pid $PID)"
        exit 1
      else
        echo "Removing stale pid file."
        rm -f "$PID_FILE"
      fi
    fi
    echo "Starting gateway..."
    nohup bun "$SRC_FILE" serve > "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    echo "Gateway started (pid $(cat "$PID_FILE"))."
    ;;
  stop)
    if [ ! -f "$PID_FILE" ]; then
      echo "Gateway is not running."
      exit 1
    fi
    PID=$(cat "$PID_FILE")
    echo "Stopping gateway (pid $PID)..."
    kill $PID 2>/dev/null || true
    rm -f "$PID_FILE"
    echo "Gateway stopped."
    ;;
  status)
    if [ -f "$PID_FILE" ]; then
      PID=$(cat "$PID_FILE")
      if ps -p $PID > /dev/null 2>&1; then
        echo "Gateway is running (pid $PID)."
      else
        echo "Gateway is not running (stale pid file)."
        rm -f "$PID_FILE"
      fi
    else
      echo "Gateway is not running."
    fi
    ;;
  *)
    echo "Usage: $0 {start|stop|status}"
    exit 1
    ;;
esac
