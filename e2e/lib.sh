# Drives a throwaway Claude Code session in tmux and reads what it draws, for e2e/<mod>.sh.
#
# The session loads the mods the way every session here does (CLAUDE_CODE_PLUGIN_DIRS in
# ~/.claude/settings.json), so it runs this checkout's files, and the user's hooks (RTK) with them.
# It costs a few small model calls: E2E_MODEL, haiku by default.
set -u

E2E_NAME=${E2E_NAME:-$(basename "$0" .sh)}
E2E_SESSION=neoncoat-e2e-$E2E_NAME
# A fixed folder, made fresh each run: the trust question is asked only on the first.
E2E_DIR=${TMPDIR:-/tmp}/neoncoat-e2e-$E2E_NAME
E2E_MODEL=${E2E_MODEL:-haiku}
E2E_FAILED=0

# What the terminal shows now.
screen() { tmux capture-pane -p -t "$E2E_SESSION"; }
# The same with the scrollback, for a transcript row that has scrolled up.
history() { tmux capture-pane -p -S -500 -t "$E2E_SESSION"; }

stop_session() { tmux kill-session -t "$E2E_SESSION" 2>/dev/null; }

pass() { echo "ok - $*"; }
# A failed check: the screen goes with it, and the run goes on to the next check.
fail() {
  echo "not ok - $*"
  screen | grep -v '^[[:space:]]*$' | sed 's/^/    | /'
  E2E_FAILED=1
}
# Ends the run: 0 when every check passed.
finish() {
  stop_session
  exit "$E2E_FAILED"
}

# Waits until the screen (or with --history, the scrollback) matches an extended regex; false after the limit.
wait_for() {
  local reader=screen
  if [ "$1" = --history ]; then
    reader=history
    shift
  fi
  local pattern=$1 limit=${2:-60} waited=0
  until $reader | grep -Eq -- "$pattern"; do
    [ "$waited" -ge "$limit" ] && return 1
    sleep 1
    waited=$((waited + 1))
  done
}

# Types text at the prompt, as literal keys, and submits it.
send_prompt() {
  tmux send-keys -t "$E2E_SESSION" -l -- "$1"
  sleep 0.5
  tmux send-keys -t "$E2E_SESSION" Enter
}

# Runs a `!` command at the prompt.
send_bash() {
  tmux send-keys -t "$E2E_SESSION" '!'
  sleep 0.5
  send_prompt "$1"
}

keys() { tmux send-keys -t "$E2E_SESSION" "$@"; }

# Starts Claude Code in a fresh git repo at $E2E_DIR, after `setup` (if defined) fills it, and waits for its prompt.
start_session() {
  case $E2E_DIR in
    */neoncoat-e2e-*) rm -rf "$E2E_DIR" ;;
    *) echo "refusing to clear $E2E_DIR" >&2 && exit 2 ;;
  esac
  mkdir -p "$E2E_DIR"
  (
    cd "$E2E_DIR" || exit 1
    git init -q
    if command -v setup >/dev/null; then setup; fi
    git add -A
    git -c user.name=e2e -c user.email=e2e@localhost commit -qm start --allow-empty
  ) || exit 2
  stop_session
  tmux new-session -d -s "$E2E_SESSION" -x 170 -y 45 -c "$E2E_DIR" "claude --model $E2E_MODEL"
  wait_for 'trust this folder|^❯' 60 || { fail 'Claude Code started' && finish; }
  if screen | grep -q 'trust this folder'; then
    keys Down
    sleep 0.5
    keys Enter
  fi
  wait_for '^❯' 60 || { fail 'the prompt showed' && finish; }
  sleep 2
}
