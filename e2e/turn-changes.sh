#!/usr/bin/env bash
# turn-changes in a real session: a Bash command's changes and an Edit's are listed in the pane, a file's press
# shows its diff, and a turn that changes nothing leaves the list as it was.
cd "$(dirname "$0")" && . ./lib.sh

setup() {
  printf 'one\ntwo\nthree\n' > a.txt
  printf 'alpha\nbeta\n' > notes.md
}

# Waits for the reply a prompt asked for: a word no other turn answers with.
replied() { wait_for --history "⏺ $1" 90; }
# The docked pane alone: what is right of its border, the transcript left out.
pane() { screen | sed -n 's/^.*│//p'; }

start_session

send_prompt "Use the Bash tool to run exactly this one command and nothing else: sed -i '' 's/two/TWO/' a.txt && printf 'fresh\\n' > b.txt   Then reply with only the word finished."
replied finished || fail 'the Bash turn ended'
send_prompt '/changes'
if wait_for 'M a\.txt \+1 −1' 15 && wait_for 'A b\.txt \+1 −0' 5; then
  pass "a Bash command's changes are listed: a.txt changed, b.txt created"
else
  fail "a Bash command's changes are listed"
fi

# ctrl+x tab gives the pane the keyboard, Tab reaches its first Button (a.txt's row), Enter presses it.
keys C-x Tab
sleep 1
keys Tab
sleep 1
keys Enter
if wait_for '← files  a\.txt' 10 && wait_for '│ *2 -two' 5 && wait_for '│ *2 \+TWO' 5; then
  pass "a file's press shows its diff"
else
  fail "a file's press shows its diff"
fi
# Enter on ← files goes back; Esc then closes the focused pane, which /changes opens again.
keys Enter
wait_for '2 files' 10 || fail 'back to the list'
keys Escape
sleep 1

send_prompt "Use the Bash tool to run exactly this one command and nothing else: cat a.txt   Then reply with only the word checked."
replied checked || fail 'the read-only turn ended'
send_prompt '/changes'
if wait_for '2 files' 15 && screen | grep -Eq 'M a\.txt \+1 −1' && screen | grep -Eq 'A b\.txt \+1 −0'; then
  pass 'a turn that changes nothing leaves the last list'
else
  fail 'a turn that changes nothing leaves the last list'
fi

send_prompt 'Use the Edit tool, not Bash, to change the word beta to BETA in notes.md. Then reply with only the word edited.'
replied edited || fail 'the Edit turn ended'
if wait_for 'M notes\.md \+1 −1' 15 && wait_for '1 file' 5 && ! pane | grep -q 'a\.txt'; then
  pass "an Edit is listed, in a list of its turn's own"
else
  fail 'an Edit is listed'
fi

finish
