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

const RAN = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
const DIFF = [
  'diff --git src/a.ts src/a.ts',
  'index 1111111..2222222 100644',
  '--- src/a.ts',
  '+++ src/a.ts',
  '@@ -1,2 +1,2 @@',
  '-const a = 1',
  '+const a = 2',
  ' export { a }',
  'diff --git old.md old.md',
  'deleted file mode 100644',
  'index 3333333..0000000',
  '--- old.md',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-gone',
  'diff --git logo.png logo.png',
  'Binary files logo.png and logo.png differ',
  '',
].join('\n')

/**
 * The repo beneath a Bash call: a snapshot before, one after, the diff between them, the files it created.
 * `top` is the repo's top and `prefix` the session root's place in it; a file `files` does not hold reads as binary.
 */
const repo = (
  on: On,
  snapshots: { exitCode?: number; tree: string; untracked: string[] }[],
  { diff = DIFF, top = '/work', prefix = '', files = { '/work/new.txt': 'hello\nworld\n' } as Record<string, string> } = {},
) => {
  const runs: string[] = []
  const reads: string[] = []
  on('process.run', (_, e) => {
    runs.push(e.argv[0]!)
    if (e.argv[0] === 'git') {
      return { value: { ...RAN, stdout: diff } }
    }
    const { exitCode = 0, tree, untracked } = snapshots.shift()!

    return { value: { ...RAN, exitCode, stdout: `${top}\n${prefix}\n${tree}\n${untracked.map(path => `${path}\0`).join('')}` } }
  })
  on('fs.read', (_, e) => {
    reads.push(e.path)

    return { value: files[e.path] ?? 'PNG\0\0' }
  })

  return { runs, reads }
}

const TREE_A = 'a'.repeat(40)
const TREE_B = 'b'.repeat(40)
const bash = ($: Engine) => $.tool.call({ tool: 'Bash', command: 'npm run format', description: 'Format' })

test("a command's changes are listed: the tracked files' diff and the text files it created", async ($, on) => {
  const { results } = machine(on)
  repo(on, [
    { tree: TREE_A, untracked: ['notes.txt'] },
    { tree: TREE_B, untracked: ['notes.txt', 'new.txt', 'image.png'] },
  ])
  await $.turn.start({ text: 'format', turnId: 't1' })
  const ran = { result: { stdout: 'done', stderr: '', interrupted: false } }
  results.push(ran)

  expect(await bash($)).toEqual(ran)
  const ui = await pane($)
  expect(await keys(ui)).toEqual(['file:src/a.ts', 'file:old.md', 'file:new.txt'])
  expect((await ui.findAll({ type: 'Text', text: /^ [+−]\d+$/ })).map(each => each.text)).toEqual([' +1', ' −1', ' +0', ' −1', ' +2', ' −0'])

  await ui.press({ key: 'file:src/a.ts' })
  expect((await ui.findAll({ type: 'Code' })).map(each => each.props.source)).toEqual(['@@ -1,2 +1,2 @@\n-const a = 1\n+const a = 2\n export { a }'])
  await ui.unmount()
})

test('outside a git repo a command passes through and nothing is listed', async ($, on) => {
  const { results } = machine(on)
  const { runs } = repo(on, [{ exitCode: 128, tree: '', untracked: [] }])
  const ran = { result: { stdout: '', stderr: '', interrupted: false } }
  results.push(ran)

  expect(await bash($)).toEqual(ran)
  expect(runs).toEqual(['sh'])
  const ui = await pane($)
  expect(await ui.find({ type: 'Text', text: /^No file changed yet/ })).toBeDefined()
  await ui.unmount()
})

test("with the bash option off a command takes no snapshot", { options: { bash: false } }, async ($, on) => {
  const { results } = machine(on)
  const { runs } = repo(on, [])
  results.push({ result: { stdout: '', stderr: '', interrupted: false } })

  await bash($)
  expect(runs).toEqual([])
})

const DONE = { result: { stdout: '', stderr: '', interrupted: false } }
const counts = async (ui: { findAll: (query: { type: string; text: RegExp }) => Promise<{ text: string }[]> }) =>
  (await ui.findAll({ type: 'Text', text: /^ [+−]\d+$/ })).map(each => each.text)
const sources = async (ui: { findAll: (query: { type: string }) => Promise<{ props: Record<string, unknown> }[]> }) =>
  (await ui.findAll({ type: 'Code' })).map(each => each.props.source)

// Real `git diff --no-prefix` output: a path with a space ends its header lines with a tab, a one-line
// hunk has no counts, a removed `-- dash` reads like a header, and a last line may have no newline.
const EDGES = [
  'diff --git my file.txt my file.txt',
  'index 210f632..d166426 100644',
  '--- my file.txt\t',
  '+++ my file.txt\t',
  '@@ -1,3 +1,3 @@',
  ' one',
  '--- dash',
  '+--- dash',
  ' three',
  'diff --git nonl.txt nonl.txt',
  'index d5ffd5c..eba5d77 100644',
  '--- nonl.txt',
  '+++ nonl.txt',
  '@@ -1 +1 @@',
  '-solo',
  '\\ No newline at end of file',
  '+solo2',
  '\\ No newline at end of file',
  'diff --git single.txt single.txt',
  'old mode 100644',
  'new mode 100755',
  'index 587be6b..975fbec',
  '--- single.txt',
  '+++ single.txt',
  '@@ -1 +1 @@',
  '-x',
  '+y',
  '',
].join('\n')

test('a diff is read as git writes it: a path with a space, a one-line hunk, a removed line like a header, no newline at the end', async ($, on) => {
  const { results } = machine(on)
  repo(on, [{ tree: TREE_A, untracked: [] }, { tree: TREE_B, untracked: [] }], { diff: EDGES })
  results.push(DONE)

  await bash($)
  const ui = await pane($)
  expect(await keys(ui)).toEqual(['file:my file.txt', 'file:nonl.txt', 'file:single.txt'])
  expect(await counts(ui)).toEqual([' +1', ' −1', ' +1', ' −1', ' +1', ' −1'])

  await ui.press({ key: 'file:my file.txt' })
  expect(await sources(ui)).toEqual(['@@ -1,3 +1,3 @@\n one\n--- dash\n+--- dash\n three'])
  await ui.press({ key: 'back' })
  await ui.press({ key: 'file:nonl.txt' })
  expect(await sources(ui)).toEqual(['@@ -1,1 +1,1 @@\n-solo\n+solo2'])
  await ui.unmount()
})

test("below the repo's top, a file is listed relative to the session root, and one outside it by its full path", async ($, on) => {
  const { results } = machine(on)
  const diff = ['diff --git app/src/a.ts app/src/a.ts', '--- app/src/a.ts', '+++ app/src/a.ts', '@@ -1 +1 @@', '-a', '+b']
  diff.push('diff --git lib/b.ts lib/b.ts', '--- lib/b.ts', '+++ lib/b.ts', '@@ -1 +1 @@', '-c', '+d', '')
  // The session runs in /repo/app.
  const { reads } = repo(on, [{ tree: TREE_A, untracked: [] }, { tree: TREE_B, untracked: ['app/new.txt'] }], {
    diff: diff.join('\n'),
    top: '/repo',
    prefix: 'app/',
    files: { '/repo/app/new.txt': 'new\n' },
  })
  results.push(DONE)

  await bash($)
  const ui = await pane($)
  expect(await keys(ui)).toEqual(['file:src/a.ts', 'file:/repo/lib/b.ts', 'file:new.txt'])
  expect(reads).toEqual(['/repo/app/new.txt'])
  await ui.unmount()
})

test('a command Claude Code ran as read-only takes one snapshot and lists nothing', async ($, on) => {
  const { results } = machine(on)
  const { runs } = repo(on, [{ tree: TREE_A, untracked: [] }])
  results.push({ ...DONE, isReadOnly: true })

  await bash($)
  expect(runs).toEqual(['sh'])
  const ui = await pane($)
  expect(await ui.find({ type: 'Text', text: /^No file changed yet/ })).toBeDefined()
  await ui.unmount()
})

test('a command that fails still lists what it changed, and its result is left as it was', async ($, on) => {
  const { results } = machine(on)
  repo(on, [{ tree: TREE_A, untracked: [] }, { tree: TREE_B, untracked: [] }])
  const failed = { isError: true as const, result: 'Exit code 1', text: 'Exit code 1' }
  results.push(failed)

  expect(await bash($)).toEqual(failed)
  const ui = await pane($)
  expect(await keys(ui)).toEqual(['file:src/a.ts', 'file:old.md'])
  await ui.unmount()
})

test("a command's change and an Edit to the same file in one turn are one row, with both edits", async ($, on) => {
  const { results } = machine(on)
  repo(on, [{ tree: TREE_A, untracked: [] }, { tree: TREE_B, untracked: [] }])
  await $.turn.start({ text: 'fix', turnId: 't1' })
  results.push(DONE, { result: edited('/work/src/a.ts', [IMPORT]) })

  await bash($)
  await edit($, '/work/src/a.ts')
  const ui = await pane($)
  expect(await keys(ui)).toEqual(['file:src/a.ts', 'file:old.md'])
  await ui.press({ key: 'file:src/a.ts' })
  expect(await sources(ui)).toHaveLength(2)
  expect(await ui.find({ type: 'Text', text: 'edit 2 of 2' })).toBeDefined()
  await ui.unmount()
})

test("a turn whose commands change nothing leaves the last changing turn's list", async ($, on) => {
  const { results } = machine(on)
  repo(on, [
    { tree: TREE_A, untracked: [] },
    { tree: TREE_B, untracked: [] },
    { tree: TREE_B, untracked: [] },
    { tree: TREE_B, untracked: [] },
  ])
  results.push(DONE, DONE)

  await $.turn.start({ text: 'format', turnId: 't1' })
  await bash($)
  await $.turn.start({ text: 'check', turnId: 't2' })
  await bash($)
  const ui = await pane($)
  expect(await keys(ui)).toEqual(['file:src/a.ts', 'file:old.md'])
  await ui.unmount()
})

test('of the files one command created, only the first 100 are read and listed', async ($, on) => {
  const { results } = machine(on)
  const made = Array.from({ length: 120 }, (_, index) => `gen/f${index}.txt`)
  const { reads } = repo(on, [{ tree: TREE_A, untracked: [] }, { tree: TREE_A, untracked: made }], {
    files: Object.fromEntries(made.map(path => [`/work/${path}`, 'x\n'])),
  })
  results.push(DONE)

  await bash($)
  expect(reads).toHaveLength(100)
  const ui = await pane($)
  expect(await keys(ui)).toHaveLength(100)
  await ui.unmount()
})

test('a snapshot that fails after the command leaves its result as it was and lists nothing', async ($, on) => {
  const { results } = machine(on)
  const { runs } = repo(on, [{ tree: TREE_A, untracked: [] }, { tree: 'fatal: index file corrupt', untracked: [] }])
  results.push(DONE)

  expect(await bash($)).toEqual(DONE)
  expect(runs).toEqual(['sh', 'sh'])
  const ui = await pane($)
  expect(await ui.find({ type: 'Text', text: /^No file changed yet/ })).toBeDefined()
  await ui.unmount()
})

test('a snapshot the engine refuses to run leaves the command to run as it would', async ($, on) => {
  const { results } = machine(on)
  on('process.run', () => ({ deny: 'no processes here' }))
  results.push(DONE)

  expect(await bash($)).toEqual(DONE)
})
