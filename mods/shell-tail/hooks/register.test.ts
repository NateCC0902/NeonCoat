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

  return { files, open, listed }
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

const band = ($: Engine) =>
  $.ui.mount({
    plugin: 'shell-tail',
    surface: 'terminal',
    component: 'AbovePrompt',
    requestId: 'band',
    props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })

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
