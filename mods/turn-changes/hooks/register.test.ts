import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, ToolCallResult } from 'claude-code'

type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }

const hunk = (oldStart: number, newStart: number, lines: string[]): Hunk => ({
  oldStart,
  oldLines: lines.filter(line => !line.startsWith('+')).length,
  newStart,
  newLines: lines.filter(line => !line.startsWith('-')).length,
  lines,
})
const edited = (filePath: string, structuredPatch: Hunk[]) => ({
  filePath,
  oldString: '',
  newString: '',
  originalFile: '',
  structuredPatch,
  userModified: false,
  replaceAll: false,
})

const IMPORT = hunk(1, 1, [" import type { Register } from 'claude-code'", "+import stringWidth from 'string-width'", ' '])
const WIDTH = hunk(99, 100, ['-const width = (text: string) =>', '-  [...text].length', '+const width = stringWidth'])

/**
 * Stands for the engine beneath the mod: the project root, the panes it
 * opens, and each tool call answered with the next result the test queued.
 */
const machine = (on: On) => {
  const opened: string[] = []
  const closable: boolean[] = []
  const results: ToolCallResult[] = []
  on('session.root', () => ({ value: '/work' }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    closable.push(e.closeOnEscape === true)

    return { value: { isPlaced: true as const } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('tool.call', () => results.shift() ?? { deny: 'nothing queued' })

  return { opened, closable, results }
}

const pane = ($: Engine) =>
  $.ui.mount({
    plugin: 'turn-changes',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'turn-changes',
    props: { title: 'Turn changes', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })

const edit = ($: Engine, file: string) => $.tool.call({ tool: 'Edit', file_path: file, old_string: 'a', new_string: 'b' })

const keys = async (ui: { findAll: (query: { type: string }) => Promise<{ key: string | undefined }[]> }) =>
  (await ui.findAll({ type: 'Button' })).map(each => each.key)

test("a turn's edits are listed by file, and a file's press shows each edit's diff", { options: { autoOpen: true } }, async ($, on) => {
  const { opened, closable, results } = machine(on)
  await $.turn.start({ text: 'use string-width', turnId: 't1' })
  results.push(
    { result: edited('/work/hooks/register.tsx', [IMPORT]) },
    { result: edited('/work/hooks/register.tsx', [WIDTH]) },
    { result: { type: 'create', filePath: '/work/package.json', content: '{\n  "private": true\n}\n', structuredPatch: [], originalFile: null } },
  )
  await edit($, '/work/hooks/register.tsx')
  await edit($, '/work/hooks/register.tsx')
  await $.tool.call({ tool: 'Write', file_path: '/work/package.json', content: '{\n  "private": true\n}\n' })
  const ui = await pane($)

  expect(opened).toEqual(['turn-changes'])
  // Inline above the prompt it may have no close mark to press: Esc closes it.
  expect(closable).toEqual([true])
  expect(await keys(ui)).toEqual(['file:hooks/register.tsx', 'file:package.json'])
  expect((await ui.find({ type: 'Text', text: '2 files' }))).toBeDefined()
  expect((await ui.findAll({ type: 'Text', text: /^\+\d+$/ })).map(each => each.text)).toEqual(['+5'])
  expect((await ui.findAll({ type: 'Text', text: /^ \+\d+$/ })).map(each => each.text)).toEqual([' +2', ' +3'])

  await ui.press({ key: 'file:hooks/register.tsx' })
  const diffs = await ui.findAll({ type: 'Code' })
  expect(diffs.map(each => each.props.source)).toEqual([
    "@@ -1,2 +1,3 @@\n import type { Register } from 'claude-code'\n+import stringWidth from 'string-width'\n ",
    '@@ -99,2 +100,1 @@\n-const width = (text: string) =>\n-  [...text].length\n+const width = stringWidth',
  ])
  expect(diffs[0]?.props).toMatchObject({ format: 'diff', path: 'hooks/register.tsx' })
  expect(await ui.find({ type: 'Text', text: 'edit 2 of 2' })).toBeDefined()

  await ui.press({ key: 'back' })
  expect(await keys(ui)).toEqual(['file:hooks/register.tsx', 'file:package.json'])
  await ui.unmount()
})

// The person's close of the pane is not raised here: a test's $ has no ui.close.
test("the next turn's first edit starts a new list, and /changes opens the pane", { options: { autoOpen: true } }, async ($, on) => {
  const { opened, results } = machine(on)
  await $.turn.start({ text: 'one', turnId: 't1' })
  results.push({ result: edited('/work/a.ts', [IMPORT]) })
  await edit($, '/work/a.ts')

  await $.turn.start({ text: 'two', turnId: 't2' })
  results.push({ result: edited('/elsewhere/b.ts', [WIDTH]) }, { result: edited('/elsewhere/b.ts', [IMPORT]) })
  await edit($, '/elsewhere/b.ts')
  await edit($, '/elsewhere/b.ts')
  const ui = await pane($)

  expect(opened).toEqual(['turn-changes', 'turn-changes'])
  expect(await keys(ui)).toEqual(['file:/elsewhere/b.ts'])

  await $.command.run({ command: 'changes', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(opened).toEqual(['turn-changes', 'turn-changes', 'turn-changes'])
  await ui.unmount()
})

test('a refused or failed edit is not listed', async ($, on) => {
  const { opened, results } = machine(on)
  results.push({ deny: 'not here' }, { result: edited('/work/a.ts', [IMPORT]), isError: true })
  await edit($, '/work/a.ts')
  await edit($, '/work/a.ts')
  const ui = await pane($)

  expect(opened).toEqual([])
  expect(await ui.find({ type: 'Text', text: /^No file changed yet/ })).toBeDefined()
  await ui.unmount()
})

test('by default the pane does not open by itself, and /changes opens it', async ($, on) => {
  const { opened, results } = machine(on)
  await $.turn.start({ text: 'one', turnId: 't1' })
  results.push({ result: edited('/work/a.ts', [IMPORT]) })
  await edit($, '/work/a.ts')
  expect(opened).toEqual([])

  await $.command.run({ command: 'changes', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(opened).toEqual(['turn-changes'])
  const ui = await pane($)
  expect(await keys(ui)).toEqual(['file:a.ts'])
  await ui.unmount()
})
