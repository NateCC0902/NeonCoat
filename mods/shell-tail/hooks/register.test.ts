import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'

const RAN = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
const PROJECT = '/private/tmp/claude-501/-work'
const TASKS = `${PROJECT}/s1/tasks`
const FILE = `${TASKS}/t1.output`
const DONE = { stdout: 'done', stderr: '', interrupted: false }
// What the engine draws under a running row: a progress line, colors, blanks.
const OUTPUT = ['> test', '\x1b[32m✔\x1b[39m one', 'two', 'three', '', 'four', 'loading 10%\rloading 100%', ''].join('\n')

/**
 * Stands for the machine and the engine beneath the mod: the session's tasks
 * folder, which the test writes as running commands would, the processes that
 * hold its files open, and the rows the engine draws.
 */
const machine = (on: On, surfaces: RenderSurface[] = ['terminal']) => {
  const files = new Map<string, string>()
  const open = new Set<string>()
  const listed: string[] = []
  // What `ps -o etime=` says of a file's holders: the shell, and the command it runs now.
  const holders = { etime: '      00:04\n      00:00\n' }
  const entry = (name: string, kind: 'file' | 'dir', size = 0) => ({ name, kind, size, mtimeMs: 0, isLink: false })

  on('session.surfaces', () => ({ value: surfaces }))
  on('session.root', () => ({ value: '/work' }))
  on('process.run', (_, e) => {
    if (e.argv[0] === 'id') {
      return { value: { ...RAN, stdout: '501\n' } }
    }
    if (e.argv[0] === 'lsof') {
      return { value: { ...RAN, stdout: e.argv.filter(arg => open.has(arg)).map(file => `p1\nn${file}\n`).join('') } }
    }
    if (e.argv[0] === 'sh' && e.argv[2]?.startsWith('ps ')) {
      return { value: { ...RAN, stdout: holders.etime } }
    }
    if (e.argv[0] === 'tail') {
      return { value: { ...RAN, stdout: (files.get(e.argv.at(-1)!) ?? '').split('\n').slice(-21).join('\n') } }
    }

    return { value: RAN }
  })
  on('fs.stat', (_, e) => {
    if (e.path === '/tmp') {
      return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: true, realPath: '/private/tmp' } }
    }
    const text = files.get(e.path)

    return text === undefined ? { deny: 'ENOENT' } : { value: { kind: 'file' as const, size: text.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.list', (_, e) => {
    listed.push(e.path)
    if (e.path === PROJECT) {
      return { value: [entry('s1', 'dir')] }
    }
    if (e.path === TASKS) {
      return { value: [...files].map(([path, text]) => entry(path.slice(TASKS.length + 1), 'file', text.length)) }
    }

    return { deny: 'ENOENT' }
  })
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => {
    const text = files.get(e.path)

    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('ui.render', { component: 'ToolUse' }, () => ({ type: 'engine' as const, ref: 0 }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine' as const, ref: 0 }))

  return { files, open, listed, holders }
}

/** A foreground command: its file appears as it starts, and it runs until `finish`. */
const command = (on: On, files: Map<string, string>, open: Set<string>) => {
  const run = { id: '', finish: (_result: object = DONE) => {} }
  on('tool.call', (_, e) => {
    run.id = e.tool_use_id
    files.set(FILE, '')
    open.add(FILE)

    return new Promise(resolve => {
      run.finish = (result = DONE) => {
        files.delete(FILE)
        open.delete(FILE)
        resolve({ result })
      }
    })
  })

  return run
}

const band = ($: Engine, hasSurvey = false) =>
  $.ui.mount({
    plugin: 'shell-tail',
    surface: 'terminal',
    component: 'AbovePrompt',
    requestId: 'band',
    props: { hasSurvey, isWorking: true, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })

/** Claude's call that goes on in the background at once, its file holding `text`. */
const background = (on: On, files: Map<string, string>, open: Set<string>, text: string) => {
  let started = 0
  on('tool.call', { tool: 'Bash' }, () => {
    started += 1
    files.set(`${TASKS}/b${started}.output`, text)
    open.add(`${TASKS}/b${started}.output`)

    return { result: { ...DONE, backgroundTaskId: `b${started}` } }
  })
}

const texts = async (ui: { findAll: (query: { type: string }) => Promise<{ text: string }[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(each => each.text)

test('a command in the foreground is left to the transcript', async ($, on) => {
  const clock = mock.clock(on)
  const { files, open } = machine(on)
  const run = command(on, files, open)

  const call = $.tool.call({ tool: 'Bash', command: 'npm test' })
  await clock.settle()
  files.set(FILE, OUTPUT)
  await clock.advance(7000)
  const ui = await band($)

  expect(await texts(ui)).toEqual([])

  run.finish()
  await call
  expect(await texts(ui)).toEqual([])
  await ui.unmount()
})

test('a command moved to the background is listed until it closes, timed from its start', async ($, on) => {
  const clock = mock.clock(on)
  const { files, open } = machine(on)
  const run = command(on, files, open)

  const call = $.tool.call({ tool: 'Bash', command: 'npm run dev' })
  await clock.settle()
  await clock.advance(3000)
  const ui = await band($)
  expect(await texts(ui)).toEqual([])

  // ctrl+b: the call ends with a task, and the command runs on with its file open.
  run.finish({ ...DONE, backgroundTaskId: 't1' })
  files.set(FILE, OUTPUT)
  open.add(FILE)
  await call
  await clock.advance(500)
  expect(await texts(ui)).toEqual(['●', 'npm run dev', '0:03', '7 lines', 'loading 100%'])

  open.delete(FILE)
  await clock.advance(2000)
  expect(await texts(ui)).toEqual([])
  await ui.unmount()
})

test('a command started in the background is found by its task id, and named by its description', async ($, on) => {
  const clock = mock.clock(on)
  const { files, open } = machine(on)
  on('tool.call', () => {
    files.set(`${TASKS}/b1.output`, 'watching\n✔ 9 passed\n')
    open.add(`${TASKS}/b1.output`)

    return { result: { ...DONE, backgroundTaskId: 'b1' } }
  })

  await $.tool.call({ tool: 'Bash', command: 'node --test --watch', description: 'Run the tests on every change', run_in_background: true })
  await clock.advance(500)
  const ui = await band($)

  expect(await texts(ui)).toEqual(['●', 'Run the tests on every change', '0:00', '2 lines', '✔ 9 passed'])
  await ui.unmount()
})

test('a session no terminal draws is left alone', async ($, on) => {
  const clock = mock.clock(on)
  const { files, open, listed } = machine(on, [])
  on('tool.call', () => {
    files.set(`${TASKS}/b1.output`, 'watching\n')
    open.add(`${TASKS}/b1.output`)

    return { result: { ...DONE, backgroundTaskId: 'b1' } }
  })

  await $.tool.call({ tool: 'Bash', command: 'node --test --watch', run_in_background: true })
  await clock.advance(1000)

  expect(listed).toEqual([])
})

test('past the rows option, the newest shells are counted on one row', { options: { rows: 2 } }, async ($, on) => {
  const clock = mock.clock(on)
  const { files, open } = machine(on)
  let started = 0
  on('tool.call', () => {
    started += 1
    const file = `${TASKS}/b${started}.output`
    files.set(file, `shell ${started}\n`)
    open.add(file)

    return { result: { ...DONE, backgroundTaskId: `b${started}` } }
  })

  for (const command of ['npm run dev', 'npm run api', 'npm run docs']) {
    await $.tool.call({ tool: 'Bash', command, run_in_background: true })
    await clock.advance(1000)
  }
  const ui = await band($)

  expect(await texts(ui)).toEqual(['●', 'npm run dev', '0:03', '1 line', 'shell 1', '●', '+2 more'])
  await ui.unmount()
})

/** One of the rows Claude Code appends for a `!` command: its text alone. */
const row = ($: Engine, uuid: string, text: string) =>
  $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'text', text }] },
    door: 'command',
    origin: { kind: 'composer' },
    uuid,
  })

test("a `!` command the person moved to the background is listed from its rows, and the stop button stops it by its task id", async ($, on) => {
  const clock = mock.clock(on)
  const { files, open } = machine(on)
  const stopped: unknown[] = []
  on('tool.call', (_, e) => {
    stopped.push(e)

    return { result: { message: 'Successfully stopped task', task_id: 'bu1', task_type: 'local_bash' } }
  })

  const file = `${TASKS}/bu1.output`
  await row($, 'r1', '<bash-input>npm run dev</bash-input>')
  // ctrl+b, 4 s in: the command runs on, and a row names its file.
  files.set(file, 'ready on :3000\n')
  open.add(file)
  await row($, 'r2', `<bash-stdout>Command was manually backgrounded by user with ID: bu1. Output is being written to: ${file}.</bash-stdout><bash-stderr></bash-stderr>`)
  await clock.advance(500)
  const ui = await band($)

  expect(await texts(ui)).toEqual(['●', 'npm run dev', '0:04', '1 line', 'ready on :3000'])

  await ui.press({ key: `stop:${file}` })
  expect(stopped).toMatchObject([{ tool: 'TaskStop', task_id: 'bu1' }])
  expect(await texts(ui)).toEqual([])
  await ui.unmount()
})

test("a `!` command's own output is not taken for a background shell", async ($, on) => {
  const clock = mock.clock(on)
  const { files, open } = machine(on)

  files.set(`${TASKS}/x.output`, 'x\n')
  open.add(`${TASKS}/x.output`)
  await row($, 'r1', '<bash-input>cat notes.txt</bash-input>')
  await row($, 'r2', `<bash-stdout>Output is being written to: ${TASKS}/x.output.</bash-stdout><bash-stderr></bash-stderr>`)
  await clock.advance(500)
  const ui = await band($)

  expect(await texts(ui)).toEqual([])
  await ui.unmount()
})

test('a stop that TaskStop refuses leaves the row, and says why', async ($, on) => {
  const clock = mock.clock(on)
  const { files, open } = machine(on)
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('tool.call', { tool: 'TaskStop' }, () => ({ deny: 'No task found with ID: b1' }))
  background(on, files, open, 'serving\n')

  await $.tool.call({ tool: 'Bash', command: 'npm run dev', run_in_background: true })
  await clock.advance(500)
  const ui = await band($)
  await ui.press({ key: `stop:${TASKS}/b1.output` })

  expect(toasts).toEqual(['Not stopped: No task found with ID: b1'])
  expect(await texts(ui)).toEqual(['●', 'npm run dev', '0:00', '1 line', 'serving'])
  await ui.unmount()
})

test('a long description and a command of several lines are cut to one short name', async ($, on) => {
  const clock = mock.clock(on)
  const { files, open } = machine(on)
  background(on, files, open, 'up\n')

  await $.tool.call({ tool: 'Bash', command: 'npm run docs', description: 'Serve the docs site and rebuild it on every change to a markdown file', run_in_background: true })
  await clock.advance(1000)
  await $.tool.call({ tool: 'Bash', command: 'cd web\nnpm run dev', run_in_background: true })
  await clock.advance(500)
  const ui = await band($)

  const names = (await ui.findAll({ type: 'Text' })).filter(each => each.props.bold).map(each => each.text)
  expect(names).toEqual(['Serve the docs site and rebuild it on every cha…', 'cd web …'])
  await ui.unmount()
})

test("a `!` command is timed by its process, days and hours too, and from now when none holds its file", async ($, on) => {
  const clock = mock.clock(on)
  const { files, open, holders } = machine(on)

  files.set(`${TASKS}/bu1.output`, 'one\n')
  open.add(`${TASKS}/bu1.output`)
  holders.etime = '1-02:03:04\n   00:00\n'
  await row($, 'r1', '<bash-input>tail -f server.log</bash-input>')
  await row($, 'r2', `<bash-stdout>Command was manually backgrounded by user with ID: bu1. Output is being written to: ${TASKS}/bu1.output.</bash-stdout>`)
  files.set(`${TASKS}/bu2.output`, 'two\n')
  open.add(`${TASKS}/bu2.output`)
  holders.etime = ''
  await row($, 'r3', '<bash-input>make watch</bash-input>')
  await row($, 'r4', `<bash-stdout>Command was manually backgrounded by user with ID: bu2. Output is being written to: ${TASKS}/bu2.output.</bash-stdout>`)
  await clock.advance(500)
  const ui = await band($)

  // A day, 2 hours, 3 minutes and 4 seconds, in hours.
  expect(await texts(ui)).toEqual(['●', 'tail -f server.log', '26:03:04', '1 line', 'one', '●', 'make watch', '0:00', '1 line', 'two'])
  await ui.unmount()
})

test('a `!` command whose own row was not seen is listed as a shell', async ($, on) => {
  const clock = mock.clock(on)
  const { files, open } = machine(on)

  files.set(`${TASKS}/bu1.output`, 'ready\n')
  open.add(`${TASKS}/bu1.output`)
  await row($, 'r1', `<bash-stdout>Command was manually backgrounded by user with ID: bu1. Output is being written to: ${TASKS}/bu1.output.</bash-stdout>`)
  await clock.advance(500)
  const ui = await band($)

  expect(await texts(ui)).toEqual(['●', 'shell', '0:04', '1 line', 'ready'])
  await ui.unmount()
})

test('a file past one read is read from its end, and counted in megabytes', async ($, on) => {
  const clock = mock.clock(on)
  const { files, open } = machine(on)
  background(on, files, open, `${'x'.repeat(5 * 1024 * 1024)}\nbuilt in 9.1s\n`)

  await $.tool.call({ tool: 'Bash', command: 'npm run build -- --watch', run_in_background: true })
  await clock.advance(500)
  const ui = await band($)

  expect(await texts(ui)).toEqual(['●', 'npm run build -- --watch', '0:00', '5.0 MB', 'built in 9.1s'])
  await ui.unmount()
})

test("a session no terminal draws leaves the person's `!` commands alone", async ($, on) => {
  const clock = mock.clock(on)
  const { files, open } = machine(on, [])

  files.set(`${TASKS}/bu1.output`, 'ready\n')
  open.add(`${TASKS}/bu1.output`)
  await row($, 'r1', '<bash-input>npm run dev</bash-input>')
  await row($, 'r2', `<bash-stdout>Command was manually backgrounded by user with ID: bu1. Output is being written to: ${TASKS}/bu1.output.</bash-stdout>`)
  await clock.advance(500)
  const ui = await band($)

  expect(await texts(ui)).toEqual([])
  await ui.unmount()
})

test('the band yields to a survey', async ($, on) => {
  const clock = mock.clock(on)
  const { files, open } = machine(on)
  background(on, files, open, 'serving\n')

  await $.tool.call({ tool: 'Bash', command: 'npm run dev', run_in_background: true })
  await clock.advance(500)
  const ui = await band($, true)

  expect(await texts(ui)).toEqual([])
  await ui.unmount()
})
