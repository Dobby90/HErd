#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
cd "$project_dir"

run_dir=build/run
pid_file=$run_dir/dev.pid
mkdir -p "$run_dir"
if ! mkdir "$run_dir/lock" 2>/dev/null; then
  printf '%s\n' '다른 기동 또는 종료 작업이 진행 중입니다.' >&2
  exit 1
fi
trap 'rmdir "$run_dir/lock"' EXIT
trap 'exit 1' HUP INT TERM

pid=
if [ -f "$pid_file" ]; then
  pid=$(cat "$pid_file")
fi

is_running() {
  case "$pid" in
    ''|0|1|*[!0-9]*) return 1 ;;
  esac
  process_args=$(ps -ww -p "$pid" -o args= 2>/dev/null) || return 1
  case "$process_args" in
    *" $project_dir/scripts/dev.mjs --herd-managed") return 0 ;;
    *) return 1 ;;
  esac
}

if ! is_running; then
  rm -f "$pid_file"
  printf '%s\n' '실행 중인 ERD 편집기가 없습니다.'
  exit 0
fi

kill -TERM "$pid" 2>/dev/null || :
remaining=15
while is_running; do
  if [ "$remaining" -eq 0 ]; then
    printf '종료를 확인하지 못했습니다 (PID %s). %s/dev.log를 확인하세요.\n' "$pid" "$run_dir" >&2
    exit 1
  fi
  sleep 1
  remaining=$((remaining - 1))
done
rm -f "$pid_file"
printf '%s\n' 'ERD 편집기와 API를 종료했습니다.'
