import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// `node --test` as it prints to a pipe: two failures among sixteen.
const NODE = [
  '> test',
  '> node --test',
  '',
  '✔ math fails on what it cannot draw, with nothing on stdout (490.175125ms)',
  '✖ picture draws a.svg as a PNG, 3 px to each of its own (131.202667ms)',
  '✔ picture fails on a missing file, with nothing on stdout (113.838917ms)',
  '✖ every diagram type the Diagrams note names is drawn (2506.201583ms)',
  'ℹ tests 16',
  'ℹ suites 0',
  'ℹ pass 14',
  'ℹ fail 2',
  'ℹ cancelled 0',
  'ℹ skipped 0',
  'ℹ todo 0',
  'ℹ duration_ms 4346.418625',
  '',
  '✖ failing tests:',
  '',
  'test at picture.test.mjs:31:1',
  '✖ picture draws a.svg as a PNG, 3 px to each of its own (131.202667ms)',
  '  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:',
  '  + actual - expected',
  '',
  '    {',
  '  +   height: 32,',
  '  -   height: 96,',
  '      width: 96',
  '    }',
  '',
  '      at TestContext.<anonymous> (file:///work/picture.test.mjs:36:10)',
  '',
  'test at render.test.mjs:58:1',
  '✖ every diagram type the Diagrams note names is drawn (2506.201583ms)',
  '  Error: xychart-beta: rsvg-convert exited with 1',
  '      at draws (file:///work/render.test.mjs:12:11)',
  '',
].join('\n')

// `claude plugin test`, a failure's error indented under its line.
const BUN = [
  'hooks/register.test.ts:',
  '(pass) a running command shows its time [124.31ms]',
  '(fail) the band lists a running command [33.49ms]',
  '  HooksError: $.ui.mount: shell-tail drew nothing on the terminal surface',
  '',
  '  the engine reported:',
  '    hooks: ui.render (AbovePrompt) refused',
  '(pass) a session no terminal draws is left alone [16.97ms]',
  '',
  ' 2 pass',
  ' 1 fail',
  'Ran 3 tests across 1 file. [0.44s]',
].join('\n')

const TSC = [
  "hooks/register.tsx(279,30): error TS2339: Property 'backgroundTaskId' does not exist on type '{}'.",
  "hooks/register.test.ts(24,35): error TS2322: Type 'string[]' is not assignable to type 'readonly RenderSurface[]'.",
  "  Type 'string' is not assignable to type 'RenderSurface'.",
].join('\n')

/** Stands for the engine's own result block, which a hook may hand on or draw over. */
const engine = (on: On) => on('ui.render', { component: 'ToolResult' }, () => ({ type: 'engine' as const, ref: 0 }))

const result = ($: Engine, output: unknown, isErrored = false) =>
  $.ui.mount({
    plugin: 'test-summary',
    surface: 'terminal',
    component: 'ToolResult',
    requestId: 'run',
    props: { tool_use_id: 'run', tool: 'Bash', output, isErrored },
  })

const texts = async (ui: { findAll: (query: { type: string }) => Promise<{ text: string }[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(each => each.text)

test('a node --test run is one count line, its failures under it with their errors', async ($, on) => {
  engine(on)
  const ui = await result($, { stdout: NODE, stderr: '', interrupted: false })
  const shown = await texts(ui)

  expect(shown.slice(0, 6)).toEqual(['  ⎿  ', '✗ 2 failed', ' · ', '✓ 14 passed', ' · 4.3s', '    '])
  expect(shown).toContain('picture draws a.svg as a PNG, 3 px to each of its own')
  expect(shown).toContain('  picture.test.mjs:31:1')
  expect(shown).toContain('  Error: xychart-beta: rsvg-convert exited with 1')
  expect(shown.some(text => text.includes('at TestContext'))).toBe(false)
  expect((await ui.find({ type: 'Text', text: '  +   height: 32,' }))?.props).toMatchObject({ color: 'success' })
  expect((await ui.find({ type: 'Text', text: '  -   height: 96,' }))?.props).toMatchObject({ color: 'error' })
  expect(JSON.stringify(await ui.drawn())).not.toContain('"engine"')
  await ui.unmount()
})

test('show passed lists the passing tests, and output hands the engine its own block', async ($, on) => {
  engine(on)
  const ui = await result($, { stdout: NODE, stderr: '', interrupted: false })

  await ui.press({ key: 'passed:run' })
  expect(await texts(ui)).toContain('math fails on what it cannot draw, with nothing on stdout (490ms)')

  await ui.press({ key: 'output:run' })
  expect(JSON.stringify(await ui.drawn())).toContain('"engine"')
  await ui.unmount()
})

test('a claude plugin test run reads the same, and a failed call is read from its error text', async ($, on) => {
  engine(on)
  const ui = await result($, `Exit code 1\n${BUN}`, true)
  const shown = await texts(ui)

  expect(shown.slice(0, 5)).toEqual(['  ⎿  ', '✗ 1 failed', ' · ', '✓ 2 passed', ' · 0.4s'])
  expect(shown).toContain('the band lists a running command')
  expect(shown).toContain('  HooksError: $.ui.mount: shell-tail drew nothing on the terminal surface')
  expect(shown).toContain('    hooks: ui.render (AbovePrompt) refused')
  await ui.unmount()
})

test('tsc errors are counted, each with its place', async ($, on) => {
  engine(on)
  const ui = await result($, `Exit code 2\n${TSC}`, true)
  const shown = await texts(ui)

  expect(shown[1]).toBe('✗ 2 type errors')
  expect(shown).toContain('  hooks/register.tsx:279')
  expect(shown).toContain("  Type 'string' is not assignable to type 'RenderSurface'.")
  await ui.unmount()
})

test('any other output is the engine\'s to draw', async ($, on) => {
  engine(on)
  const ui = await result($, { stdout: 'On branch main\nnothing to commit', stderr: '', interrupted: false })

  expect(await ui.find({ type: 'Text' })).toBeUndefined()
  expect(JSON.stringify(await ui.drawn())).toContain('"engine"')
  await ui.unmount()
})
