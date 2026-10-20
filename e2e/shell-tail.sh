#!/usr/bin/env bash
# shell-tail in a real session: Claude's background shell and the person's (`!`, ctrl+b) are
# listed above the prompt and read on while no turn runs, and the stop button stops one.
. "$(dirname "$0")/lib.sh"

# The loops run for minutes: whatever this run leaves going is stopped with it.
trap 'pkill -f "e2e-(tick|person) " 2>/dev/null' EXIT

# A band row: the dot at the start of the line, then the name.
row() { screen | grep -E "^● $1" | head -n 1; }
lines() { row "$1" | grep -Eo '[0-9]+ lines?' | grep -Eo '[0-9]+'; }
seconds() { row "$1" | grep -Eo '[0-9]+:[0-9]{2}' | head -n 1 | awk -F: '{ print $1 * 60 + $2 }'; }
# The footer's count, at its line's end: `Ran 1 shell command` in the transcript is not it.
shells() { screen | grep -Eo '· [0-9]+ shells?$' | tail -n 1 | grep -Eo '[0-9]+'; }
# Waits until a shell's row has left the band and the footer counts the shells left (none: empty); false after 15 s.
gone() {
  for _ in $(seq 1 15); do
    ! row "$1" | grep -q . && [ "$(shells)" = "$2" ] && return 0
    sleep 1
  done
  return 1
}
# The band's stop button, drawn in reverse while it is the one Enter presses.
armed() { tmux capture-pane -e -p -t "$E2E_SESSION" | grep -q $'\e\\[7mstop'; }

start_session

# Claude's own: named by its call's description, and its file read on after the turn ends.
send_prompt 'Use the Bash tool with run_in_background set to true and the description "Count e2e ticks" to run exactly: for i in $(seq 1 600); do echo e2e-tick $i; sleep 1; done   Then reply only with the word started.'
if wait_for '^● Count e2e ticks .*[0-9]+ lines?' 90 && wait_for --history '⏺ started' 30; then
  pass "Claude's background command is listed by its description"
else
  fail "Claude's background command is listed by its description"
fi
before=$(lines 'Count e2e ticks')
sleep 3
after=$(lines 'Count e2e ticks')
if [ -n "$before" ] && [ -n "$after" ] && [ "$after" -gt "$before" ]; then
  pass "its row reads on while no turn runs ($before → $after lines)"
else
  fail "its row reads on while no turn runs (${before:-none} → ${after:-none} lines)"
fi

# The person's: a `!` command sent to the background after a few seconds, timed from its start.
send_bash 'for i in $(seq 1 600); do echo e2e-person $i; sleep 1; done'
wait_for 'e2e-person 6$' 30 || fail 'the `!` command ran in the foreground'
# Inside tmux, Claude Code takes ctrl+b twice.
keys C-b
keys C-b
if wait_for '^● for i in .*e2e-person' 20; then
  pass 'the `!` command sent to the background is listed by its command'
else
  fail 'the `!` command sent to the background is listed by its command'
fi
ran=$(seconds 'for i in')
if [ -n "$ran" ] && [ "$ran" -ge 5 ]; then
  pass "its clock counts from its start (${ran}s)"
else
  fail "its clock counts from its start (${ran:-no}s, 5s or more expected)"
fi
wait_for '· 2 shells' 10 || fail 'the footer counts 2 shells'

# The stop button: the band focused (ctrl+x tab), Enter presses its first, the oldest row's.
keys C-x
keys Tab
for _ in 1 2 3 4 5; do armed && break || sleep 1; done
armed || fail 'the band took focus with its stop button armed'
keys Enter
if gone 'Count e2e ticks' 1; then
  pass "stop takes Claude's command off the band, and the footer counts 1 shell"
else
  fail "stop takes Claude's command off the band, and the footer counts 1 shell"
fi
sleep 1
if pgrep -f 'e2e-tick ' >/dev/null; then
  fail "Claude's command was stopped (its process is still running)"
else
  pass "Claude's command was stopped"
fi

# The person's too, from a band focused again.
armed || {
  keys C-x
  keys Tab
}
for _ in 1 2 3 4 5; do armed && break || sleep 1; done
keys Enter
if gone 'for i in' ''; then
  pass 'stop takes the `!` command off the band, and the footer counts no shell'
else
  fail 'stop takes the `!` command off the band, and the footer counts no shell'
fi
sleep 1
if pgrep -f 'e2e-person ' >/dev/null; then
  fail 'the `!` command was stopped (its process is still running)'
else
  pass 'the `!` command was stopped'
fi

finish
