import { atom, read, update } from 'claude-code'
import type { BuiltinToolResults, EngineInterface, Register, Timer } from 'claude-code'

import type { Shell } from '../types'

type Shells = Record<string, Shell>

const shells = atom({ plugin: 'shell-tail', key: 'shells' } as const, {} as Shells)

// shortcut: no API says where a background command's output goes. Claude Code
// writes it to <tmp>/claude-<uid>/<project>/<session>/tasks/<task>.output, the
// session being the one the process started as (a /clear keeps it). If a
// release moves it, the mod finds nothing and the band stays empty.
const TICK_MS = 500
// lsof takes about 0.3 s, so whether a shell still runs is asked every 2 s.
const ALIVE_EVERY = 4
// What one $.fs.read takes; past it, `tail` reads the end of the file.
const READ_LIMIT = 4 * 1024 * 1024
const LABEL_WIDTH = 48
// Color codes, cursor moves and window titles, which a row would draw as junk.
const ESCAPES = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

let project: string | undefined
let folder: string | undefined
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

/** What a shell is called in the band: its call's description, else its command's first line, cut to fit. */
const label = (shell: Shell) => {
  const text = (shell.description ?? shell.command).trim()
  const [line = ''] = text.split('\n')
  if (line.length > LABEL_WIDTH) {
    return `${line.slice(0, LABEL_WIDTH - 1)}…`
  }

  return text.includes('\n') ? `${line} …` : line
}

/** The tasks folders a shell's file may be in: this session's once known, else every session's of the project. */
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

/** Reads the shells that grew, and drops the ones that ended. */
async function tick($: EngineInterface) {
  if (isTicking) {
    return
  }
  isTicking = true
  try {
    ticks += 1
    const now = await $.clock.now()
    const known = await read($, shells)
    const files = Object.keys(known)
    // A shell runs while a process holds its file open: the file outlives it.
    let open: Set<string> | undefined
    if (ticks % ALIVE_EVERY === 0 && files.length > 0) {
      const { stdout } = await $.process.run(['lsof', '-F', 'n', '--', ...files])
      open = new Set(stdout.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1)))
    }

    const next: Shells = {}
    for (const shell of Object.values(known)) {
      if (open !== undefined && !open.has(shell.file)) {
        continue
      }
      try {
        const { size } = await $.fs.stat(shell.file)
        const fresh = await reread($, shell, size)
        next[shell.file] = { ...fresh, elapsedMs: Math.floor((now - shell.startedAt) / 1000) * 1000 }
      } catch {
        // Gone: its file was removed.
      }
    }

    const isSame = files.length === Object.keys(next).length && files.every(file => JSON.stringify(next[file]) === JSON.stringify(known[file]))
    if (!isSame) {
      // A shell that started meanwhile stands.
      await update($, shells, current => {
        const merged: Shells = {}
        for (const [file, shell] of Object.entries(current)) {
          if (!(file in known)) {
            merged[file] = shell
          } else if (file in next) {
            merged[file] = next[file]!
          }
        }

        return merged
      })
    }

    if (Object.keys(await read($, shells)).length === 0) {
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

/** Watches a background command's file, which its task id names. */
async function follow($: EngineInterface, id: string, call: Pick<Shell, 'command' | 'description' | 'startedAt'>) {
  for (const dir of await folders($)) {
    const file = `${dir}/${id}.output`
    if (!(await $.fs.exists(file))) {
      continue
    }
    folder = dir
    const shell: Shell = { ...call, file, elapsedMs: 0, lastLine: '', lineCount: 0, size: -1 }
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

  // A command in the foreground is in the transcript already: only one that goes on in the background is listed.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const startedAt = await $.clock.now()
    const ran = await next(e)
    const id = backgroundTask(ran)
    if (id !== undefined && (await $.session.surfaces()).includes('terminal')) {
      await follow($, id, { command: e.command, description: e.description, startedAt })
    }

    return ran
  })

  // Above the prompt: every background shell still running, how long it has run, how much it wrote and its last line.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const running = Object.values(await read($, shells)).sort((a, b) => a.startedAt - b.startedAt)
    if (e.surface !== 'terminal' || e.props.hasSurvey || running.length === 0) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const beneath = await next(e)

    // The engine's own node may not sit under a sized Box: only the rows are sized.
    // The dot is the one accent, in the theme's color for background work, as on the footer's shell count.
    return (
      <Box flexDirection="column">
        <Box flexDirection="column" width={e.props.bodyColumns}>
          {running.map(shell => (
            <Box key={shell.file} flexDirection="row" columnGap={2}>
              <Box flexDirection="row" columnGap={1}>
                <Text color="background">●</Text>
                <Text bold>{label(shell)}</Text>
              </Box>
              <Text color="subtle">{clock(shell.elapsedMs)}</Text>
              <Text color="subtle">{amount(shell)}</Text>
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                <Text color="inactive" wrap="truncate-end">
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
