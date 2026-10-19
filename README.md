# NeonCoat

Mods and a status line for [Claude Code](https://claude.com/claude-code). A reply's diagrams, formulas, images and videos are drawn as pictures in the terminal, its markdown is drawn in color, background shells, test runs and a turn's edits get views of their own, and the status line says what the session is costing.

![A Claude Code reply drawn in the terminal: a flowchart, a formula, a table, a task list, a callout, a code card, then a video playing in place](docs/demo.gif)

## What is in here

| Path | What it does |
| --- | --- |
| `mods/reply-media/` | Draws `mermaid` fences, formulas (`math` fences and `$$` blocks) and local images (`![alt](path)` on a line of its own) as pictures. A local video written as an image is drawn as its first frame with a play button, and plays in place. Under each picture, one button copies its source and one opens it larger in a pane. |
| `mods/reply-markdown/` | Draws headings, lists, task lists, quotes, callouts (`> [!WARNING]`), rules and tables in color, and puts each code fence in a card with a copy button. |
| `mods/skill-router/` | `/skill-router <question>` asks a small model which of your user-only skills fits the question. With no question it lists them. |
| `mods/shell-tail/` | Lists every shell Claude has running in the background in a band above the prompt, named by what it does: how long it has run, how many lines it wrote, and its last line. A command in the foreground is left to the transcript. |
| `mods/test-summary/` | Draws a test or type-check run (`node --test`, `bun test`, `claude plugin test`, `tsc`) as one count line with each failure and its error under it. The passing tests, a copy of the failures and the whole output are a press away. |
| `mods/turn-changes/` | Lists the files the last turn changed in a pane, each with its diff a press away. The pane opens by itself where the terminal is wide enough; `/changes` opens it anywhere. |
| `statusline.mjs` | The status line. First row: context used, cost, model, tokens per second, folder, cache hit rate, git state. Second row: subscription windows and when they refill, Remote Control, and the other sessions running on the machine. |

## What `reply-markdown` draws

Headings, lists, a quote, a rule, and bold, italic and inline code:

<img src="docs/markdown-text.png" width="830" alt="A reply with three levels of heading, a nested bullet list, a numbered list, a quote and a rule, each in its own color">

The five callouts:

<img src="docs/markdown-callouts.png" width="830" alt="Note, Tip, Important, Warning and Caution, each a box in its own color">

A table, a task list, and a code fence as a card with its copy button:

<img src="docs/markdown-blocks.png" width="830" alt="A table ruled under its header and between its rows, a task list with two items ticked, and a TypeScript snippet in a card with a copy button">

## What the tool views draw

A dev server left running in the background, a failing test run, the fix, and the run again:

![A Claude Code session: a background dev server listed in a band above the prompt, a test run drawn as one count line with its failure, a pane listing the file the fix changed and then its diff, and the tests passing](docs/tool-views.gif)

- `shell-tail`: the band above the prompt, one row per background shell, its dot in the theme's color for background work.
- `test-summary`: the count line under `Ran 1 shell command`, each failure and its diff under it.
- `turn-changes`: the pane on the right, opened by the turn's first edit. A press on a file shows its diff.

## Requirements

- Claude Code with the mod API (function-hook plugins). The API is early access and may change under these mods. Last run on Claude Code 2.1.296.
- macOS. The picture scripts call `sips` and `open`.
- For `reply-media`, a terminal that speaks the kitty graphics protocol: Ghostty or kitty.
- Node.js, and for `reply-media`:

```bash
brew install librsvg ffmpeg
```

## Install

```bash
git clone https://github.com/NateCC0902/NeonCoat.git
cd NeonCoat/mods/reply-media/render && npm install
```

Then point `~/.claude/settings.json` at the clone. `CLAUDE_CODE_PLUGIN_DIRS` is colon-separated with one entry per mod (a parent folder is not scanned), so leave out the mods you do not want:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/NeonCoat/mods/reply-media:/path/to/NeonCoat/mods/reply-markdown:/path/to/NeonCoat/mods/skill-router:/path/to/NeonCoat/mods/shell-tail:/path/to/NeonCoat/mods/test-summary:/path/to/NeonCoat/mods/turn-changes"
  },
  "statusLine": {
    "type": "command",
    "command": "node /path/to/NeonCoat/statusline.mjs",
    "padding": 0,
    "refreshInterval": 5
  }
}
```

The mods load in sessions started after that. These files are loaded live from the clone: a saved mod file hot-reloads in running sessions, so a broken edit breaks the terminal UI of all of them.

## Tell Claude what to write

`reply-media` draws only what Claude writes in the forms it knows: a `mermaid` fence, a `math` fence, an image on a line of its own. Claude does not write them unprompted, so the mod tells it: it adds a note to the system prompt (`FORMS` in `mods/reply-media/hooks/register.tsx`). `reply-markdown` does the same for the forms it draws only when Claude chooses to write them: alerts, task lists, and a code fence for what you will copy. A note is added only where a reply is drawn on a terminal, not under `claude -p` or in an app, where the forms would come out as their source; a mod turned off adds none. There is nothing to put in your `CLAUDE.md`.

## Options

Each mod's options are rows in `/config`, and a change takes effect at once.

| Mod | Option | Default | What it changes |
| --- | --- | --- | --- |
| all six | `enabled` | `true` | Turns the mod off without removing it. |
| `reply-media` | `pxPerColumn` | `8` | Pixels of a picture per terminal column. Lower draws pictures larger. |
| `reply-media` | `cellAspect` | `2.17` | How many times taller than wide one terminal cell is. Change it when pictures look squashed or stretched. |
| `reply-media` | `resumedReplies` | `3` | How many of a resumed session's last replies get their pictures drawn again. |
| `reply-markdown` | `tableBorder` | `rules` | `rules`: no frame, a line under the header and a faint one between the rows. Or a frame: `round`, `single` or `bold`. |
| `reply-markdown` | `cardBorder` | `round` | The border of a code card and of a callout box: `round`, `single` or `bold`. |

## Colors

The colors are written into the code to match one dark theme, which is not in this repo. For another theme, edit the constants at the top of each file: `COLORS` in `statusline.mjs`, `COLOR` and `CALLOUT` in `mods/reply-markdown/hooks/register.tsx`, and `THEME` in `mods/reply-media/render/render.mjs`. `shell-tail`, `test-summary` and `turn-changes` name the theme's own colors (`background`, `success`, `error`, `subtle`), so they follow whichever theme is set.

## Checks

Run these after a change, from the repo's root:

```bash
claude plugin validate mods/<name> && claude plugin test mods/<name>
npx -p typescript tsc -p mods/<name>
(cd mods/reply-media/render && npm test)
echo '{}' | node statusline.mjs && node --test statusline.test.mjs
```

The types check works once Claude Code has loaded the mod and written its types to `mods/<name>/.claude-plugin/types/`. `CLAUDE.md` has the notes for changing or adding a mod.
