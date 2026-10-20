#!/usr/bin/env bash
# reply-markdown in a real session: bold that Chinese punctuation ends is drawn bold, in a paragraph the engine
# draws and in a list item the mod draws, and a code span keeps its asterisks.
cd "$(dirname "$0")" && . ./lib.sh

setup() {
  printf '%s\n' '**短答：就夠了。**記憶函式庫' '' '- **Letta 的實驗。**Letta 是' '' '看**「重點」**吧，`**原樣。**b`' > reply.md
}

# The scrollback holds the line as drawn, its bold marks gone (and its 。 outside them, which reads the same).
drawn() {
  if history | grep -Fq -- "$1"; then pass "$2"; else fail "$2"; fi
}

start_session

send_prompt 'Read reply.md, then reply with its exact contents as your whole reply: no code fence, no comment.'
wait_for --history '原樣' 90 || fail 'the reply came'
sleep 2

drawn '短答：就夠了。記憶函式庫' "a paragraph's bold closes before 。"
drawn '• Letta 的實驗。Letta 是' "a list item's bold closes before 。"
drawn '看「重點」吧，**原樣。**b' "bold closes around 「」, and a code span keeps its **"

finish
