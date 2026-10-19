import { atom, read, update } from 'claude-code'
import type { BuiltinToolResults, EngineInterface, Register, Timer } from 'claude-code'

import type { Shell } from '../types'

type Shells = Record<string, Shell>

const shells = atom({ plugin: 'shell-tail', key: 'shells' } as const, {} as Shells)

// shortcut: no API says where a running command's output goes. Claude Code
// writes it to <tmp>/claude-<uid>/<project>/<session>/tasks/<task>.output, the
// session being the one the process started as (a /clear keeps it), and
// removes a foreground command's file once it ends. If a release moves it,
// the mod finds nothing and the band stays empty.
const TICK_MS = 500
// lsof takes about 0.3 s, so whether a shell still runs is asked every 2 s.
const ALIVE_EVERY = 4
// What one $.fs.read takes; past it, `tail` reads the end of the file.
const READ_LIMIT = 4 * 1024 * 1024
const COMMAND_WIDTH = 40
// Color codes, cursor moves and window titles, which a row would draw as junk.
const ESCAPES = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

/** A foreground call whose output file has not been found yet. */
type Pending = { toolUseId: string; command: string; startedAt: number; before: Set<string> }

let project: string | undefined
let folder: string | undefined
let pending: Pending[] = []
let timer: Timer | undefined
let isTicking = false
let ticks = 0

/** A file's last line as the band shows it: progress redraws and colors gone, blanks skipped. */
const lastLine = (text: string) =>
  text
    .slice(-16384)
    .split('\n')
    .map(line => (line.replace(/\r$/, '').split('\r').at(-1) ?? '').replace(ESCAPES, '').trimEnd())
    .filter(line => line.trim() !== '')
    .at(-1) ?? ''

/** The task a Bash call went on as in the background (run_in_background, ctrl+b, its timeout). */
// A matched hook's `next(e)` is not typed per tool, so Bash's record is named here.
const backgroundTask = (ran: { result?: unknown }) =>
  (ran.result as BuiltinToolResults['Bash'] | undefined)?.backgroundTaskId

const lineCount = (text: string) => {
  let count = text === '' || text.endsWith('\n') ? 0 : 1
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) {
    count += 1
  }

  return count
}

const clock = (ms: number) => {
  const seconds = Math.floor(ms / 1000)

  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

const amount = (shell: Shell) =>
  shell.lineCount === null
    ? `${(shell.size / 1048576).toFixed(1)} MB`
    : `${shell.lineCount} line${shell.lineCount === 1 ? '' : 's'}`

/** A command's first line, cut to fit beside the others in the band. */
const label = (command: string) => {
  const [line = ''] = command.trim().split('\n')
  if (line.length > COMMAND_WIDTH) {
    return `${line.slice(0, COMMAND_WIDTH - 1)}…`
  }

  return command.trim().includes('\n') ? `${line} …` : line
}

/** The tasks folders a new output file may appear in: this session's once known, else every session's of the project. */
async function folders($: EngineInterface) {
  if (folder !== undefined) {
    return [folder]
  }
  if (project === undefined) {
    const { stdout } = await $.process.run(['id', '-u'])
    // lsof answers with real paths, and macOS's /tmp is a link.
    const { realPath = '/tmp' } = await $.fs.stat('/tmp', { resolve: true })
    project = `${realPath}/claude-${stdout.trim()}/${(await $.session.root()).replace(/[^a-zA-Z0-9]/g, '-')}`
  }
  const root = project
  const sessions = await $.fs.list(root).catch(() => [])

  return sessions.filter(each => each.kind === 'dir').map(each => `${root}/${each.name}/tasks`)
}

/** The output files in the folders, oldest first. */
async function outputs($: EngineInterface, dirs: readonly string[]) {
  const listed = await Promise.all(
    dirs.map(async dir =>
      (await $.fs.list(dir).catch(() => []))
        .filter(each => each.kind === 'file' && each.name.endsWith('.output'))
        .map(each => ({ path: `${dir}/${each.name}`, mtimeMs: each.mtimeMs })),
    ),
  )

  return listed.flat().sort((a, b) => a.mtimeMs - b.mtimeMs)
}

/** A shell read again when its file grew. */
async function reread($: EngineInterface, shell: Shell, size: number): Promise<Shell> {
  if (size === shell.size) {
    return shell
  }
  if (size > READ_LIMIT) {
    const { stdout } = await $.process.run(['tail', '-n', '20', shell.file])

    return { ...shell, size, lastLine: lastLine(stdout), lineCount: null }
  }
  const text = await $.fs.read(shell.file)

  return { ...shell, size, lastLine: lastLine(text), lineCount: lineCount(text) }
}

/** Finds the files of calls that started, reads the shells that grew, and drops the ones that ended. */
async function tick($: EngineInterface) {
  if (isTicking) {
    return
  }
  isTicking = true
  try {
    ticks += 1
    const now = await $.clock.now()
    const known = await read($, shells)
    const found: Shells = {}

    // A foreground call's file is the first one new since the call started.
    if (pending.length > 0) {
      const fresh = (await outputs($, await folders($))).filter(each => !(each.path in known))
      for (const call of [...pending]) {
        const isNew = (each: { path: string }) => !call.before.has(each.path) && !(each.path in found)
        const file = fresh.find(isNew)
        if (file === undefined) {
          continue
        }
        pending = pending.filter(each => each !== call)
        // shortcut: until the session's folder is known, a command another session of
        // the project starts at the same moment may be taken for this one. The folder
        // is kept only from a file that was the one new file anywhere.
        if (folder === undefined && fresh.filter(isNew).length === 1) {
          folder = file.path.slice(0, file.path.lastIndexOf('/'))
        }
        found[file.path] = {
          command: call.command,
          file: file.path,
          toolUseId: call.toolUseId,
          isBackground: false,
          startedAt: call.startedAt,
          elapsedMs: 0,
          lastLine: '',
          lineCount: 0,
          size: -1,
        }
      }
    }

    const all = { ...known, ...found }
    const files = Object.keys(all)
    // A background shell runs while a process holds its file open, which outlives it.
    // A foreground one's file is removed once it ends, so it needs no asking.
    const background = Object.values(all).filter(shell => shell.isBackground).map(shell => shell.file)
    let open: Set<string> | undefined
    if (ticks % ALIVE_EVERY === 0 && background.length > 0) {
      const { stdout } = await $.process.run(['lsof', '-F', 'n', '--', ...background])
      open = new Set(stdout.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1)))
    }

    const next: Shells = {}
    for (const shell of Object.values(all)) {
      if (shell.isBackground && open !== undefined && !open.has(shell.file)) {
        continue
      }
      try {
        const { size } = await $.fs.stat(shell.file)
        const fresh = await reread($, shell, size)
        next[shell.file] = { ...fresh, elapsedMs: Math.floor((now - shell.startedAt) / 1000) * 1000 }
      } catch {
        // Gone: a foreground command's file is removed once it ends.
      }
    }

    const isSame = files.length === Object.keys(next).length && files.every(file => JSON.stringify(next[file]) === JSON.stringify(known[file]))
    if (!isSame) {
      // What a call that ended or went to the background did meanwhile stands.
      await update($, shells, current => {
        const merged: Shells = {}
        for (const [file, shell] of Object.entries(current)) {
          if (!(file in all)) {
            merged[file] = shell
          } else if (file in next) {
            merged[file] = { ...next[file]!, toolUseId: shell.toolUseId, isBackground: shell.isBackground }
          }
        }
        for (const file of Object.keys(found)) {
          if (file in next) {
            merged[file] = next[file]!
          }
        }

        return merged
      })
    }

    if (pending.length === 0 && Object.keys(await read($, shells)).length === 0) {
      timer?.cancel()
      timer = undefined
    }
  } finally {
    isTicking = false
  }
}

function watch($: EngineInterface) {
  timer ??= $.clock.every(TICK_MS, () => tick($))
}

/** A call that ended drops its shell, or keeps it as a background one when it was moved there (ctrl+b, its timeout). */
async function settle($: EngineInterface, toolUseId: string, backgroundTaskId: string | undefined) {
  await update($, shells, current => {
    const next: Shells = {}
    for (const [file, shell] of Object.entries(current)) {
      if (shell.toolUseId !== toolUseId) {
        next[file] = shell
      } else if (backgroundTaskId !== undefined) {
        const { toolUseId: _, ...rest } = shell
        next[file] = { ...rest, isBackground: true }
      }
    }

    return next
  })
}

/** Watches a background command's file, which its task id names. */
async function follow($: EngineInterface, id: string, command: string) {
  for (const dir of await folders($)) {
    const file = `${dir}/${id}.output`
    if (!(await $.fs.exists(file))) {
      continue
    }
    folder = dir
    const startedAt = await $.clock.now()
    const shell: Shell = { command, file, isBackground: true, startedAt, elapsedMs: 0, lastLine: '', lineCount: 0, size: -1 }
    await update($, shells, current => ({ ...current, [file]: shell }))
    watch($)

    return
  }
}

export const register: Register = (on, options) => {
  if (options.enabled === false) {
    return
  }

  // A reload keeps the shells but starts the module over: watch them again.
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if (Object.keys(await read($, shells)).length > 0) {
      watch($)
    }

    return started
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!(await $.session.surfaces()).includes('terminal')) {
      return next(e)
    }

    if (e.run_in_background === true) {
      const ran = await next(e)
      const id = backgroundTask(ran)
      if (id !== undefined) {
        await follow($, id, e.command)
      }

      return ran
    }

    const before = new Set((await outputs($, await folders($))).map(each => each.path))
    pending.push({ toolUseId: e.tool_use_id, command: e.command, startedAt: await $.clock.now(), before })
    watch($)
    const ran = await next(e).finally(() => {
      pending = pending.filter(each => each.toolUseId !== e.tool_use_id)
    })
    await settle($, e.tool_use_id, backgroundTask(ran))

    return ran
  })

  // Above the prompt: every shell still running, how long it has run, how much it wrote and its last line.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const running = Object.values(await read($, shells)).sort(
      (a, b) => Number(a.isBackground) - Number(b.isBackground) || a.startedAt - b.startedAt,
    )
    if (e.surface !== 'terminal' || e.props.hasSurvey || running.length === 0) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const beneath = await next(e)

    // The engine's own node may not sit under a sized Box: only the rows are sized.
    return (
      <Box flexDirection="column">
        <Box flexDirection="column" width={e.props.bodyColumns}>
          {running.map(shell => (
            <Box key={shell.file} flexDirection="row" columnGap={2}>
              <Text color={shell.isBackground ? 'claude' : 'inactive'}>●</Text>
              <Text>{label(shell.command)}</Text>
              <Text dimColor>{shell.isBackground ? `bg ${clock(shell.elapsedMs)}` : clock(shell.elapsedMs)}</Text>
              <Text dimColor>{amount(shell)}</Text>
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                <Text dimColor wrap="truncate-end">
                  {shell.lastLine}
                </Text>
              </Box>
            </Box>
          ))}
        </Box>
        {beneath}
      </Box>
    )
  })
}
