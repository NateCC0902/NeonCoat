# NeonCoat

Nate's own Claude Code customizations: the mods (function-hook plugins) and the status line script.

Everything here is live. `~/.claude/settings.json` loads these files straight from this folder, so an edit reaches every Claude Code session on this machine: a saved mod file hot-reloads in running sessions, and the status line script runs every 5 seconds. A broken file here breaks the terminal UI of all of them, so run the checks below before ending a turn.

## Layout

| Path | What it is | Loaded by, in `~/.claude/settings.json` |
| --- | --- | --- |
| `mods/reply-media/` | Draws three kinds of block of a reply as pictures in the terminal (kitty graphics): `mermaid` fences, formulas (`math` fences and `$$` blocks), and local images (`![alt](path)` on a line of its own). A local video written as an image (mp4, m4v, mov, webm, mkv, gif) is drawn as its first frame with a play button: `ffmpeg` cuts it into frames at the first play, the mod swaps them in place, and `open` hands the clip to the system's player. A block that fails to draw is boxed in the error color, with the reason its script gave. Under each picture, one button copies its source (an image's path) and one opens it larger in a pane. `render/` holds the Node scripts the mod runs, one per kind, with their own `package.json`. | `env.CLAUDE_CODE_PLUGIN_DIRS` |
| `mods/reply-markdown/` | Draws a reply's headings, lists (task items as checkboxes), quotes, callouts (`> [!WARNING]`), rules and tables in color, and puts each code fence in a card with a copy button. | `env.CLAUDE_CODE_PLUGIN_DIRS` |
| `mods/skill-router/` | `/skill-router <question>` asks a small model which of the skills only the user can run fits the question (read from `~/.claude/skills` and `skillOverrides` on each run); with no question it lists them. It adds nothing to the system prompt. | `env.CLAUDE_CODE_PLUGIN_DIRS` |
| `mods/shell-tail/` | Lists every shell running in the background in a band above the prompt: how long it has run, how many lines it wrote, its last line, and a stop button, which stops it through Claude Code's own TaskStop. Claude's (`run_in_background`, ctrl+b, a timeout) are named by their call's description. A `!` command the person moves there with ctrl+b is no tool call: the mod learns it from the two rows Claude Code appends to the transcript (`<bash-input>`, then `Command was manually backgrounded…` with its file), and times it by its process (`ps -o etime=`). A command in the foreground is in the transcript already and is not listed. It reads the file Claude Code writes a running command's output to, `<tmp>/claude-<uid>/<project>/<session>/tasks/<task>.output`, which no API names: if a release moves it, the band stays empty. A background shell stays listed while a process holds its file open (`lsof`). | `env.CLAUDE_CODE_PLUGIN_DIRS` |
| `mods/test-summary/` | Draws a test or type-check run's output (`node --test`'s spec reporter, `bun test` and `claude plugin test`, `cargo test`, `go test -v`, `pytest`, `vitest`, `jest`, `tsc`, each also in the compact form the RTK hook rewrites it to) as one count line with each failure and the head of its error under it; show passed, copy failures and the whole output are buttons. A command that stands alone gets it in its result block (`ToolResult`). Commands the transcript folds into a count line (`Ran 1 shell command`, a `ToolGroup`) draw no result block, so it goes under that line, and the output button unfolds the group. Output it does not recognize is left to the engine. | `env.CLAUDE_CODE_PLUGIN_DIRS` |
| `mods/turn-changes/` | Lists in a pane the files the main loop's last turn changed (a subagent's edits count toward the turn that started it), with the lines added and removed; a file's press shows each edit's diff. Edit and Write report their own changes. A Bash call's are read from the git repo: a snapshot before and after it (`git add -u` into a copy of the index, so the real one is never touched, about 80 ms each), diffed, plus the untracked files it created; outside a git repo a command's changes are not listed, and the `bash` option turns the snapshots off. `/changes` opens the pane at any width, and Esc at an empty prompt closes it. With the `autoOpen` option on (it is off by default) it also opens by itself at a turn's first change where the terminal is wide enough (144 columns), and not again after the person closes it until `/changes`. | `env.CLAUDE_CODE_PLUGIN_DIRS` |
| `statusline.mjs` | The status line: one Node script, session JSON on stdin, colored rows on stdout. It also reads Claude Code's registry of running sessions (`~/.claude/sessions/`) to say whether the session is under Remote Control and what the other sessions are doing. | `statusLine.command`, as an absolute path |

Not in this repo: the theme, `~/.claude/themes/charm.json`. Claude Code reads themes only from that folder. `statusline.mjs` carries a copy of its colors.

## Adding or changing a mod

Load the `plugin-authoring` skill first: the mod API is early access, and the types it points to are the reference. `.claude-plugin/types/` inside each mod is written by the engine when it loads the mod. Never edit it.

A new mod is a folder `mods/<name>/` plus its path appended to `env.CLAUDE_CODE_PLUGIN_DIRS`. That value is colon-separated with one entry per mod; a parent folder is not scanned. The mod loads in sessions started after that.

A mod's options are declared under `userConfig` in its `plugin.json` and reach the module as `register(on, options)`. Each one is a row in `/config`, stored under `pluginConfigs` in `~/.claude/settings.json`, and a change reloads the mod with the new values. Every mod here has an `enabled` option, which its `register` checks first, and a switch for each feature it draws (`diagrams`, `tables`, `nodeTest`...): one switched off is left to the engine, as if the mod did not draw it.

The engine refuses to load a module that passes `$` to anything but a function declared at the top of the file. A helper that takes `$` cannot be a closure inside `register`.

The reply-media mod draws only what Claude writes in the forms above, and Claude learns those forms from the Diagrams, Math and Images notes the mod adds to the system prompt (`forms` in its `register.tsx`, through `prompt.compose`). Its Formatting note does the same for the reply-markdown mod: alerts, task lists, and a code fence for what the user will copy. A mod adds its note only where a reply is drawn on a terminal, not under `-p`, the SDK or an app, where the forms would come out as their source; a mod turned off adds none, and a form switched off is left out of it. The reply-media mod likewise renders a picture only where a terminal will draw it. Change a form and its note together. A note rides on every request, so it names only what changes how Claude writes: what a mod does by itself (table frames, the copy and zoom buttons) is not listed there.

The two `reply-` mods both draw a reply (`ui.render` of `AssistantMessage`), and each hands the other the text it does not draw, so either may sit above the other. Two rules keep that true. The reply-markdown mod leaves `mermaid` and `math` fences as text. A `Button`'s key comes from what it acts on, not from a count: one reply reaches a mod in several parts, and a count would repeat from part to part.

## Checks

- A mod: `claude plugin validate mods/<name>`, then `claude plugin test mods/<name>`.
- A mod's types: `npx -p typescript tsc -p mods/<name>`. This works once the engine has loaded the mod and laid its types.
- The reply-media mod's renderer scripts: `cd mods/reply-media/render && npm test`. After a fresh clone, run `npm install` there first. They need `rsvg-convert` (`brew install librsvg`), `ffmpeg` (`brew install ffmpeg`) and macOS's `sips`.
- The status line: `echo '{}' | node statusline.mjs` exits 0 and prints its rows, then `node --test statusline.test.mjs`.
- A mod end to end, in a throwaway session: `claude -p --no-session-persistence --plugin-dir mods/<name> "<a prompt that shows the mod's effect>"`. The two `reply-` mods do nothing under `-p`: see them in a session on a terminal, where a saved file hot-reloads.
