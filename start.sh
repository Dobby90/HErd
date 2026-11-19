#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
cd "$project_dir"

if ! command -v node >/dev/null 2>&1 || [ ! -f node_modules/vite/package.json ]; then
  printf '%s\n' 'Node.js를 준비한 뒤 pnpm install --frozen-lockfile을 실행하세요.' >&2
  exit 1
fi

run_dir=build/run
pid_file=$run_dir/dev.pid
log_file=$run_dir/dev.log
mkdir -p "$run_dir"
if ! mkdir "$run_dir/lock" 2>/dev/null; then
  printf '%s\n' '다른 기동 또는 종료 작업이 진행 중입니다.' >&2
  exit 1
fi
trap 'rmdir "$run_dir/lock"' EXIT
trap 'exit 1' HUP INT TERM

if [ -f "$pid_file" ]; then
  pid=$(cat "$pid_file")
  case "$pid" in
    ''|0|1|*[!0-9]*) ;;
    *)
      process_args=$(ps -ww -p "$pid" -o args= 2>/dev/null) || process_args=
      case "$process_args" in
        *" $project_dir/scripts/dev.mjs --herd-managed")
          printf '이미 실행 중입니다 (PID %s). 로그는 %s에 있습니다.\n' "$pid" "$log_file"
          exit 0
          ;;
      esac
      ;;
  esac
fi

nohup node --env-file-if-exists=.env "$project_dir/scripts/dev.mjs" --herd-managed >"$log_file" 2>&1 </dev/null &
pid=$!
if ! printf '%s\n' "$pid" >"$pid_file"; then
  kill -TERM "$pid" 2>/dev/null || :
  exit 1
fi

remaining=15
while [ "$remaining" -gt 0 ]; do
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$pid_file"
    printf '기동에 실패했습니다. %s를 확인하세요.\n' "$log_file" >&2
    exit 1
  fi
  web_url=$(sed -n 's/^HERD_WEB_URL=//p' "$log_file")
  if [ -n "$web_url" ]; then
    printf 'ERD 편집기 %s\n로그 %s\n' "$web_url" "$log_file"
    exit 0
  fi
  sleep 1
  remaining=$((remaining - 1))
done

printf '기동 완료를 확인하지 못했습니다. %s를 확인하세요.\n' "$log_file" >&2
exit 1
