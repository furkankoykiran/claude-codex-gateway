#!/bin/bash
PID_FILE=".gateway.pid"

case "$1" in
  start)
    if [ -f "$PID_FILE" ]; then
      echo "Gateway is already running (pid $(cat $PID_FILE))"
      exit 1
    fi
    echo "Starting gateway..."
    nohup bun src/index.ts serve > gateway.log 2>&1 &
    echo $! > "$PID_FILE"
    echo "Gateway started (pid $(cat $PID_FILE))."
    ;;
  stop)
    if [ ! -f "$PID_FILE" ]; then
      echo "Gateway is not running."
      exit 1
    fi
    PID=$(cat "$PID_FILE")
    echo "Stopping gateway (pid $PID)..."
    kill $PID
    rm -f "$PID_FILE"
    echo "Gateway stopped."
    ;;
  status)
    if [ -f "$PID_FILE" ]; then
      PID=$(cat "$PID_FILE")
      if ps -p $PID > /dev/null; then
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
