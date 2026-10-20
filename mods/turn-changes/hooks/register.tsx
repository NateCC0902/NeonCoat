import { atom, read, update } from 'claude-code'
import type { BuiltinToolResults, EngineInterface, Register, ToolCallResult } from 'claude-code'

import type { FileChange, Hunk } from '../types'

const turn = atom({ plugin: 'turn-changes', key: 'turn' } as const, null)
const changes = atom({ plugin: 'turn-changes', key: 'changes' } as const, { turnId: null, files: [] as FileChange[] })
const open = atom({ plugin: 'turn-changes', key: 'open' } as const, null)
const isDismissed = atom({ plugin: 'turn-changes', key: 'isDismissed' } as const, false)

// Esc at an idle, empty prompt closes it: inline above the prompt, it may have no close mark to press.
const PANE = { id: 'turn-changes', title: 'Turn changes', closeOnEscape: true } as const

type Written = BuiltinToolResults['Edit'] | BuiltinToolResults['Write']

// A snapshot stages the worktree into a copy of the index, so the real one is never touched,
// and only `add -u`: an untracked file is listed, never hashed into .git/objects.
// Prints the repo's top, the session root's place in it, the tree, then the untracked files.
const SNAPSHOT = `prefix=$(git rev-parse --show-prefix) && cd "$(git rev-parse --show-toplevel)" && index=$(git rev-parse --git-path index) && tmp=$(mktemp) || exit 1
trap 'rm -f "$tmp" "$tmp.lock"' EXIT
cp "$index" "$tmp" 2>/dev/null || rm -f "$tmp"
tree=$(GIT_INDEX_FILE=$tmp git add -u && GIT_INDEX_FILE=$tmp git write-tree) || exit 1
printf '%s\\n%s\\n%s\\n' "$PWD" "$prefix" "$tree" && git ls-files -o --exclude-standard -z`
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
// shortcut: a Bash call that creates more files than this lists only these, raise it if an install or a scaffold needs more.
const NEW_FILES = 100

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
const count = (hunks: Hunk[], mark: string) =>
  hunks.reduce((sum, hunk) => sum + hunk.lines.filter(line => line.startsWith(mark)).length, 0)

/** A new file's whole content as one hunk. */
const created = (content: string): Hunk => {
  const lines = content.replace(/\n$/, '').split('\n')

  return { oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map(line => `+${line}`) }
}

/** An edit's hunks; a new file reports none, so its whole content is one. */
const hunksOf = (result: Written): Hunk[] => {
  if (result.structuredPatch.length > 0) {
    return result.structuredPatch.map(hunk => ({ ...hunk, lines: [...hunk.lines] }))
  }
  if ('type' in result && result.type === 'create' && result.content !== '') {
    return [created(result.content)]
  }

  return []
}

/** Hunks as the unified diff a `Code` draws under `format: 'diff'`. */
const unified = (hunks: Hunk[]) =>
  hunks.map(hunk => [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines].join('\n')).join('\n')

/** Adds a file's change to the turn's files, and opens the pane at the turn's first when `isOpened`. */
async function add($: EngineInterface, path: string, isNew: boolean, hunks: Hunk[], isOpened: boolean) {
  if (hunks.length === 0) {
    return
  }
  const turnId = await read($, turn)
  let isFirst = false

  await update($, changes, current => {
    const files = current.turnId === turnId ? current.files : []
    isFirst = files.length === 0
    const known = files.find(file => file.path === path)
    const file: FileChange = {
      path,
      isNew: known?.isNew ?? isNew,
      added: (known?.added ?? 0) + count(hunks, '+'),
      removed: (known?.removed ?? 0) + count(hunks, '-'),
      edits: [...(known?.edits ?? []), hunks],
    }

    return { turnId, files: known ? files.map(each => (each === known ? file : each)) : [...files, file] }
  })
  if (isFirst) {
    await update($, open, () => null)
    // Unasked, a pane is placed only where the terminal is wide enough for a sidebar.
    if (isOpened && !(await read($, isDismissed))) {
      void $.ui.open(PANE)
    }
  }
}

/** Adds an edit that went through. */
async function record($: EngineInterface, ran: ToolCallResult, isOpened: boolean) {
  const result = ran.result as Written | undefined
  if (ran.deny !== undefined || ran.isError === true || result === undefined) {
    return
  }
  const root = await $.session.root()
  const path = result.filePath.startsWith(`${root}/`) ? result.filePath.slice(root.length + 1) : result.filePath
  await add($, path, 'type' in result && result.type === 'create', hunksOf(result), isOpened)
}

type Snapshot = { top: string; prefix: string; tree: string; untracked: Set<string> }

/** The repo's tracked files as one tree, and its untracked files: undefined outside a git repo. */
async function snapshot($: EngineInterface): Promise<Snapshot | undefined> {
  const { exitCode, stdout } = await $.process.run(['sh', '-c', SNAPSHOT], { cwd: await $.session.root() })
  const lines = stdout.split('\n')
  const [top = '', prefix = '', tree = ''] = lines
  if (exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(tree)) {
    return undefined
  }

  return { top, prefix, tree, untracked: new Set(lines.slice(3).join('\n').split('\0').filter(Boolean)) }
}

// git ends a `---` or `+++` line with a tab when its path holds a space.
const headerPath = (line: string) => line.slice(4).replace(/\t$/, '')

/** `git diff --no-prefix`'s files, by their path in the repo, each with its hunks. */
const parseDiff = (text: string) => {
  const files: { path: string; isNew: boolean; hunks: Hunk[] }[] = []
  let from = ''
  let isHeader = false
  for (const line of text.split('\n')) {
    const start = HUNK.exec(line)
    if (line.startsWith('diff --git ')) {
      isHeader = true
    } else if (isHeader && line.startsWith('--- ')) {
      from = headerPath(line)
    } else if (isHeader && line.startsWith('+++ ')) {
      const to = headerPath(line)
      files.push({ path: to === '/dev/null' ? from : to, isNew: from === '/dev/null', hunks: [] })
    } else if (start && files.length > 0) {
      isHeader = false
      const [, oldStart, oldLines = '1', newStart, newLines = '1'] = start
      files.at(-1)!.hunks.push({ oldStart: Number(oldStart), oldLines: Number(oldLines), newStart: Number(newStart), newLines: Number(newLines), lines: [] })
    } else if (!isHeader && /^[ +-]/.test(line)) {
      files.at(-1)?.hunks.at(-1)?.lines.push(line)
    }
  }

  return files
}

/** Adds what a Bash call changed since `before`: the tracked files' diff, and the files it created. */
async function recordBash($: EngineInterface, before: Snapshot, isOpened: boolean) {
  const after = await snapshot($)
  if (after === undefined || after.top !== before.top) {
    return
  }
  const changed: ReturnType<typeof parseDiff> = []
  if (after.tree !== before.tree) {
    const { stdout } = await $.process.run(
      ['git', '-c', 'core.quotepath=off', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-prefix', before.tree, after.tree],
      { cwd: after.top },
    )
    changed.push(...parseDiff(stdout))
  }
  const fresh = [...after.untracked].filter(path => !before.untracked.has(path))
  for (const path of fresh.slice(0, NEW_FILES)) {
    // Over 4 MiB, gone, or binary: left out.
    const content = await $.fs.read(`${after.top}/${path}`).catch(() => '')
    if (content !== '' && !content.includes('\0')) {
      changed.push({ path, isNew: true, hunks: [created(content)] })
    }
  }
  for (const file of changed) {
    const path = file.path.startsWith(after.prefix) ? file.path.slice(after.prefix.length) : `${after.top}/${file.path}`
    await add($, path, file.isNew, file.hunks, isOpened)
  }
}

export const register: Register = (on, options) => {
  if (options.enabled === false) {
    return
  }
  // Off by default: then the pane opens by /changes alone.
  const autoOpen = options.autoOpen === true
  // Off, a command's changes are not looked for, and a Bash call skips the two snapshots.
  const isBashFollowed = options.bash !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'changes', description: 'Show the files the last turn changed, each with its diff, in a pane' })

    return next(e)
  })

  on('command.run', { command: 'changes' }, async $ => {
    await update($, isDismissed, () => false)
    const opened = await $.ui.open(PANE)

    return { text: opened.isPlaced ? 'Opened the turn changes pane.' : `The turn changes pane is not shown: ${opened.reason}.` }
  })

  on('ui.close', { id: PANE.id }, async ($, e, next) => {
    if (e.origin.kind === 'person') {
      await update($, isDismissed, () => true)
    }

    return next(e)
  })

  // The main loop's turns only: a subagent's edits count toward the turn that started it.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, turn, () => e.turnId)
    }

    return next(e)
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    await record($, ran, autoOpen)

    return ran
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    await record($, ran, autoOpen)

    return ran
  })

  // A file a command changed: the repo snapshotted before and after the call, outside a git repo nothing.
  // shortcut: a background call's later writes are missed, an edit or another command running at the same
  // time is counted twice, and an untracked file that was already there and changed is missed; snapshot
  // per turn instead if one of these bites.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!isBashFollowed) {
      return next(e)
    }
    const before = await snapshot($).catch(() => undefined)
    const ran = await next(e)
    // A call Claude Code ran as read-only (ls, grep) changed nothing: no second snapshot.
    if (before !== undefined && ran.deny === undefined && ran.isReadOnly !== true) {
      await recordBash($, before, autoOpen).catch(() => undefined)
    }

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE.id }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const { files } = await read($, changes)
    const openPath = await read($, open)
    const shown = files.find(file => file.path === openPath)
    const totals = (added: number, removed: number) => (
      <Box flexDirection="row" columnGap={1}>
        <Text color="success">+{added}</Text>
        <Text color="error">−{removed}</Text>
      </Box>
    )

    if (files.length === 0) {
      return <Text color="subtle">No file changed yet. A turn's edits show here as it makes them.</Text>
    }

    if (shown === undefined) {
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Text color="subtle">{plural(files.length, 'file')}</Text>
            {totals(
              files.reduce((sum, file) => sum + file.added, 0),
              files.reduce((sum, file) => sum + file.removed, 0),
            )}
          </Box>
          {files.map(file => {
            const at = file.path.lastIndexOf('/') + 1

            return (
              <Button key={`file:${file.path}`} plain onPress={() => update($, open, () => file.path)}>
                <Text color={file.isNew ? 'success' : 'claude'}>{file.isNew ? 'A ' : 'M '}</Text>
                <Text color="subtle">{file.path.slice(0, at)}</Text>
                {file.path.slice(at)}
                <Text color="success"> +{file.added}</Text>
                <Text color="error"> −{file.removed}</Text>
              </Button>
            )
          })}
          <Text color="subtle">Press a file to see what the turn changed in it.</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={2}>
          <Button key="back" plain label="← files" onPress={() => update($, open, () => null)} />
          <Text bold>{shown.path}</Text>
          {totals(shown.added, shown.removed)}
        </Box>
        {shown.edits.map((hunks, index) => (
          <Box flexDirection="column" marginTop={1}>
            {shown.edits.length > 1 && <Text color="subtle">edit {index + 1} of {shown.edits.length}</Text>}
            <Code format="diff" path={shown.path} source={unified(hunks)} wrap="truncate-end" />
          </Box>
        ))}
      </Box>
    )
  })
}
