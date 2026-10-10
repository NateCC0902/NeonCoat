# claude-garage

Nate's own Claude Code customizations: the mods (function-hook plugins) and the status line script.

Everything here is live. `~/.claude/settings.json` loads these files straight from this folder, so an edit reaches every Claude Code session on this machine: a saved mod file hot-reloads in running sessions, and the status line script runs every 5 seconds. A broken file here breaks the terminal UI of all of them, so run the checks below before ending a turn.

## Layout

| Path | What it is | Loaded by, in `~/.claude/settings.json` |
| --- | --- | --- |
| `mods/mermaid/` | Draws the `mermaid` code fences of a reply as pictures in the terminal (kitty graphics). `render/` is a Node program the mod runs, with its own `package.json`. | `env.CLAUDE_CODE_PLUGIN_DIRS` |
| `mods/readable/` | Draws the headings, list markers and rules of a reply in color. | `env.CLAUDE_CODE_PLUGIN_DIRS` |
| `mods/skill-router/` | Adds a system prompt section listing the skills only the user can run (read from `~/.claude/skills` and `skillOverrides` at load), so Claude names the right `/skill` at the right moment. | `env.CLAUDE_CODE_PLUGIN_DIRS` |
| `statusline.mjs` | The status line: one Node script, session JSON on stdin, colored rows on stdout. | `statusLine.command`, as an absolute path |

Not in this repo: the theme, `~/.claude/themes/charm.json`. Claude Code reads themes only from that folder. `statusline.mjs` carries a copy of its colors.

## Adding or changing a mod

Load the `plugin-authoring` skill first: the mod API is early access, and the types it points to are the reference. `.claude-plugin/types/` inside each mod is written by the engine when it loads the mod. Never edit it.

A new mod is a folder `mods/<name>/` plus its path appended to `env.CLAUDE_CODE_PLUGIN_DIRS`. That value is colon-separated with one entry per mod; a parent folder is not scanned. The mod loads in sessions started after that.

## Checks

- A mod: `claude plugin validate mods/<name>`, then `claude plugin test mods/<name>`.
- A mod's types: `npx -p typescript tsc -p mods/<name>`. This works once the engine has loaded the mod and laid its types.
- The mermaid renderer: `cd mods/mermaid/render && npm test`. After a fresh clone, run `npm install` there first.
- The status line: `echo '{}' | node statusline.mjs` exits 0 and prints its rows.
- A mod end to end, in a throwaway session: `claude -p --no-session-persistence --plugin-dir mods/<name> "<a prompt that shows the mod's effect>"`.
