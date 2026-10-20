#!/usr/bin/env bash
# test-summary end to end: Claude runs a failing test suite for each runner installed here, and the
# transcript shows the run as one count line with the failing test under it. The user's RTK hook
# rewrites `cargo test` and `go test`, so their compact forms are what is read.
. "$(dirname "$0")/lib.sh"

setup() {
  printf 'target/\n' > .gitignore
  mkdir node
  cat > node/t.test.mjs <<'EOF'
import { test } from 'node:test'
import assert from 'node:assert/strict'
test('node adds', () => assert.equal(1 + 2, 3))
test('node breaks', () => assert.equal(2 + 2, 5))
EOF
  if command -v cargo >/dev/null; then
    mkdir -p rs/src
    printf '[package]\nname = "rs"\nversion = "0.1.0"\nedition = "2021"\n' > rs/Cargo.toml
    cat > rs/src/lib.rs <<'EOF'
#[cfg(test)]
mod tests {
    #[test]
    fn cargo_adds() { assert_eq!(1 + 2, 3); }
    #[test]
    fn cargo_adds_too() { assert_eq!(2 + 2, 4); }
    #[test]
    fn cargo_breaks() { assert_eq!(2 + 2, 5, "two and two"); }
}
EOF
  fi
  if command -v go >/dev/null; then
    mkdir go
    printf 'module gt\n\ngo 1.21\n' > go/go.mod
    cat > go/a_test.go <<'EOF'
package gt

import "testing"

func TestGoOne(t *testing.T)    {}
func TestGoTwo(t *testing.T)    {}
func TestGoThree(t *testing.T)  {}
func TestGoBreaks(t *testing.T) { t.Errorf("got %d, want %d", 4, 5) }
EOF
  fi
}

# Has Claude run one command, then looks for the run's count line and its failing test.
# The last run's count line and a line of its output are kept for the output button's check.
check_run() {
  local runner=$1 command=$2 count=$3 failing=$4
  last_count=$count
  last_output=$5
  send_prompt "Use the Bash tool once to run exactly: $command   Run nothing else. Then reply with only the word done-$runner"
  if ! wait_for --history "⏺ done-$runner( |$)" 240; then
    fail "$runner: Claude ran the command and replied"
    return
  fi
  if wait_for --history "$count" 5; then pass "$runner: the run is one count line, $count"; else fail "$runner: the run is one count line, $count"; fi
  if history | grep -q -- "✗ $failing"; then pass "$runner: the failing test is under it"; else fail "$runner: the failing test is under it"; fi
}

# Presses a transcript button by its label, with a mouse click: buttons there take no keys.
click() {
  local row col
  read -r row col < <(screen | python3 -I -c '
import sys
for index, line in enumerate(sys.stdin.read().split("\n")):
    if sys.argv[1] in line and sys.argv[2] in line:
        print(index + 1, line.rindex(sys.argv[2]) + 2)
' "$1" "$2")
  [ -n "${row:-}" ] || return 1
  tmux send-keys -t "$E2E_SESSION" -l $'\e[<0;'"$col;$row"$'M\e[<0;'"$col;$row"'m'
}

start_session

check_run node 'node --test node/t.test.mjs' '✗ 1 failed · ✓ 1 passed' 'node breaks' 'ℹ duration_ms'
if command -v cargo >/dev/null; then
  check_run cargo 'cd rs && cargo test' '✗ 1 failed · ✓ 2 passed' 'tests::cargo_breaks' 'test result: FAILED'
else
  echo 'skip - cargo is not installed'
fi
if command -v go >/dev/null; then
  # -v: go's own output names no passing test without it, where no RTK hook rewrites the command.
  check_run go 'cd go && go test -v ./...' '✗ 1 failed · ✓ 3 passed' 'TestGoBreaks' 'Go test: 3 passed|=== RUN'
else
  echo 'skip - go is not installed'
fi

# The last run's output button, still on screen, unfolds the output the engine draws.
if click "$last_count" 'output' && wait_for 'hide output' 10 && wait_for "$last_output" 5; then
  pass 'output unfolds the last run as the engine draws it'
else
  fail 'output unfolds the last run as the engine draws it'
fi

finish
