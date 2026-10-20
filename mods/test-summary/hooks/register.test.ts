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

test('a folded group draws each run under its count line, and output unfolds it', async ($, on) => {
  const expanded: boolean[] = []
  on('ui.render', { component: 'ToolGroup' }, (_, e) => {
    expanded.push(e.props.isExpanded)

    return { type: 'engine' as const, ref: 0 }
  })
  const group = (output: unknown) =>
    $.ui.mount({
      plugin: 'test-summary',
      surface: 'terminal',
      component: 'ToolGroup',
      requestId: 'group',
      props: {
        calls: [
          { tool_use_id: 'read', tool: 'Read', input: {}, isRunning: false, isErrored: false, isInterrupted: false, output: '' },
          { tool_use_id: 'run', tool: 'Bash', input: {}, isRunning: false, isErrored: true, isInterrupted: false, output },
        ],
        isActive: false,
        isExpanded: false,
      },
    })

  const ui = await group(`Exit code 1\n${NODE}`)
  expect((await texts(ui)).slice(0, 4)).toEqual(['  ⎿  ', '✗ 2 failed', ' · ', '✓ 14 passed'])
  expect(JSON.stringify(await ui.drawn())).toContain('"engine"')
  await ui.press({ key: 'output:run' })
  expect(expanded.at(-1)).toBe(true)
  expect(await ui.find({ type: 'Button', key: 'output:run' })).toMatchObject({ props: { label: 'hide output' } })
  await ui.unmount()

  const other = await group({ stdout: 'On branch main', stderr: '', interrupted: false })
  expect(await other.find({ type: 'Text' })).toBeUndefined()
  expect(expanded.at(-1)).toBe(false)
  await other.unmount()
})

test('a runner switched off leaves its output to the engine', { options: { nodeTest: false } }, async ($, on) => {
  engine(on)
  const ui = await result($, { stdout: NODE, stderr: '', interrupted: false })

  expect(await ui.find({ type: 'Text' })).toBeUndefined()
  expect(JSON.stringify(await ui.drawn())).toContain('"engine"')
  await ui.unmount()
})

test('a failure shows as many lines of its error as the option says', { options: { failureLines: 2 } }, async ($, on) => {
  engine(on)
  const ui = await result($, { stdout: NODE, stderr: '', interrupted: false })
  const shown = await texts(ui)

  expect(shown).toContain('  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:')
  expect(shown).toContain('  + actual - expected')
  expect(shown).not.toContain('  +   height: 32,')
  await ui.unmount()
})

// Each runner's real output, its own and as RTK prints it (`rtk cargo test` and the like), paths cut to /work.
const CARGO = [
  '   Compiling rs v0.1.0 (/work/rs)',
  '    Finished `test` profile [unoptimized + debuginfo] target(s) in 3.25s',
  '     Running unittests src/lib.rs (target/debug/deps/rs-8457387f435de152)',
  '',
  'running 2 tests',
  'test tests::adds ... ok',
  'test tests::breaks ... FAILED',
  '',
  'failures:',
  '',
  '---- tests::breaks stdout ----',
  '',
  "thread 'tests::breaks' (12964883) panicked at src/lib.rs:8:19:",
  'assertion `left == right` failed: two and two',
  '  left: 4',
  ' right: 5',
  'note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace',
  '',
  '',
  'failures:',
  '    tests::breaks',
  '',
  'test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
  '',
  'error: test failed, to rerun pass `--lib`',
].join('\n')
const CARGO_RTK = [
  '---- tests::breaks stdout ----',
  '',
  "thread 'tests::breaks' (12964910) panicked at src/lib.rs:8:19:",
  'assertion `left == right` failed: two and two',
  '  left: 4',
  ' right: 5',
  'note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace',
  '',
  '',
  'test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
  '[full output: "$HOME/Library/Application Support/rtk/tee/1792513960_cargo_test.log"]',
].join('\n')
const GO = [
  '=== RUN   TestAdds',
  '--- PASS: TestAdds (0.00s)',
  '=== RUN   TestBreaks',
  '    a_test.go:4: got 4, want 5',
  '--- FAIL: TestBreaks (0.00s)',
  'FAIL',
  'FAIL\tgt\t0.331s',
  'FAIL',
].join('\n')
const GO_RTK = [
  'Go test: 1 passed, 1 failed in 1 packages',
  '',
  'gt (1 passed, 1 failed)',
  '  [FAIL] TestBreaks',
  '     a_test.go:4: got 4, want 5',
  '[full output: "$HOME/Library/Application Support/rtk/tee/1792513964_go_test.log"]',
].join('\n')
const PYTEST = [
  '============================= test session starts ==============================',
  'platform darwin -- Python 3.14.7, pytest-9.1.1, pluggy-1.7.0',
  'rootdir: /work/py',
  'collected 2 items',
  '',
  'test_a.py .F                                                             [100%]',
  '',
  '=================================== FAILURES ===================================',
  '_________________________________ test_breaks __________________________________',
  '',
  '    def test_breaks():',
  '>       assert 2 + 2 == 5, "two and two"',
  'E       AssertionError: two and two',
  'E       assert (2 + 2) == 5',
  '',
  'test_a.py:5: AssertionError',
  '=========================== short test summary info ============================',
  'FAILED test_a.py::test_breaks - AssertionError: two and two',
  '========================= 1 failed, 1 passed in 0.02s ==========================',
].join('\n')
const PYTEST_RTK = [
  'Pytest: 1 passed, 1 failed in 0.01s',
  '',
  'Failures:',
  '1. [FAIL] test_breaks',
  '     test_a.py:5: in test_breaks',
  '     assert 2 + 2 == 5, "two and two"',
  '     E   AssertionError: two and two',
].join('\n')
const VITEST = [
  '',
  ' RUN  v5.0.5 /work/js',
  '',
  ' ❯ v/a.test.js (2 tests | 1 failed) 4ms',
  '   × breaks 2ms',
  '',
  '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯',
  '',
  ' FAIL  v/a.test.js > breaks',
  'AssertionError: expected 4 to be 5 // Object.is equality',
  '',
  '- Expected',
  '+ Received',
  '',
  '- 5',
  '+ 4',
  '',
  ' ❯ v/a.test.js:3:38',
  "      1| import { test, expect } from 'vitest'",
  "      2| test('adds', () => { expect(1 + 2).toBe(3) })",
  "      3| test('breaks', () => { expect(2 + 2).toBe(5) })",
  '       |                                      ^',
  '      4|',
  '',
  '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯',
  '',
  '',
  ' Test Files  1 failed (1)',
  '      Tests  1 failed | 1 passed (2)',
  '   Start at  00:34:31',
  '   Duration  145ms (transform 41%, import 27%, tests 22%, worker 10%)',
  '',
].join('\n')
const JEST = [
  'FAIL j/a.test.cjs',
  '  ● breaks',
  '',
  '    expect(received).toBe(expected) // Object.is equality',
  '',
  '    Expected: 5',
  '    Received: 4',
  '',
  "      1 | test('adds', () => { expect(1 + 2).toBe(3) })",
  "    > 2 | test('breaks', () => { expect(2 + 2).toBe(5) })",
  '        |                                      ^',
  '      3 |',
  '',
  '      at Object.<anonymous> (a.test.cjs:2:38)',
  '',
  'Test Suites: 1 failed, 1 total',
  'Tests:       1 failed, 1 passed, 2 total',
  'Snapshots:   0 total',
  'Time:        0.109 s',
  'Ran all test suites.',
].join('\n')
// RTK prints vitest's and jest's runs alike.
const JEST_RTK = [
  'PASS (1) FAIL (1)',
  '',
  '1. breaks',
  '   Error: expect(received).toBe(expected) // Object.is equality',
  '   ',
  '   Expected: 5',
  '   Received: 4',
  '       at Object.<anonymous> (/work/js/j/a.test.cjs:2:38)',
  '       at Promise.finally.completed (/work/js/node_modules/jest-circus/build/jestAdapterInit.js:1834:28)',
  '[full output: "$HOME/Library/Application Support/rtk/tee/1792514092_jest_run.log"]',
].join('\n')
// bun prints a failure's error before its (fail) line, where claude plugin test prints it after.
const BUN_OWN = [
  'bun test v1.4.3 (c6da4a4d3)',
  '',
  'a.test.ts:',
  '1 | import { test, expect } from "bun:test"',
  '2 | test("adds", () => { expect(1 + 2).toBe(3) })',
  '3 | test("breaks", () => { expect(2 + 2).toBe(5) })',
  '                                         ^',
  'error: expect(received).toBe(expected)',
  '',
  'Expected: 5',
  'Received: 4',
  '',
  '      at <anonymous> (/work/bn/a.test.ts:3:38)',
  '(fail) breaks [0.62ms]',
  '',
  ' 1 pass',
  ' 1 fail',
  ' 2 expect() calls',
  'Ran 2 tests across 1 file. [6.00ms]',
].join('\n')
const BUN_RTK = [
  '[FAIL] FAILURES:',
  '  (fail) breaks [0.11ms]',
  '  error: expect(received).toBe(expected)',
  '  Expected: 5',
  '  Received: 4',
  '  at <anonymous> (/work/bn/a.test.ts:3:38)',
  '',
  'SUMMARY:',
  '   1 pass',
  '   1 fail',
  '  Ran 2 tests across 1 file. [2.00ms]',
  '',
  '[full output: "$HOME/Library/Application Support/rtk/tee/1792514247_bun_test.log"]',
].join('\n')

const RUNS = [
  { runner: 'cargo test', output: CARGO, seconds: ' · 0.0s', name: 'tests::breaks', at: 'src/lib.rs:8', error: ['assertion `left == right` failed: two and two', '  left: 4', ' right: 5'] },
  { runner: 'RTK cargo test', output: CARGO_RTK, seconds: ' · 0.0s', name: 'tests::breaks', at: 'src/lib.rs:8', error: ['assertion `left == right` failed: two and two'] },
  { runner: 'go test -v', output: GO, name: 'TestBreaks', at: 'a_test.go:4', error: ['got 4, want 5'] },
  { runner: 'RTK go test', output: GO_RTK, name: 'TestBreaks', at: 'a_test.go:4', error: ['got 4, want 5'] },
  { runner: 'pytest', output: PYTEST, seconds: ' · 0.0s', name: 'test_breaks', at: 'test_a.py:5', error: ['AssertionError: two and two', 'assert (2 + 2) == 5'] },
  { runner: 'RTK pytest', output: PYTEST_RTK, seconds: ' · 0.0s', name: 'test_breaks', at: 'test_a.py:5', error: ['AssertionError: two and two'] },
  { runner: 'vitest', output: VITEST, seconds: ' · 0.1s', name: 'breaks', at: 'v/a.test.js:3', error: ['AssertionError: expected 4 to be 5 // Object.is equality', '- Expected', '+ 4'] },
  { runner: 'jest', output: JEST, seconds: ' · 0.1s', name: 'breaks', at: 'a.test.cjs:2', error: ['expect(received).toBe(expected) // Object.is equality', 'Expected: 5', 'Received: 4'] },
  { runner: 'RTK jest and vitest', output: JEST_RTK, name: 'breaks', at: '/work/js/j/a.test.cjs:2', error: ['Error: expect(received).toBe(expected) // Object.is equality', 'Received: 4'] },
  { runner: 'bun test', output: BUN_OWN, seconds: ' · 0.0s', name: 'breaks', at: '/work/bn/a.test.ts:3', error: ['error: expect(received).toBe(expected)', 'Received: 4'] },
  { runner: 'RTK bun test', output: BUN_RTK, seconds: ' · 0.0s', name: 'breaks', at: '/work/bn/a.test.ts:3', error: ['error: expect(received).toBe(expected)', 'Received: 4'] },
]

for (const run of RUNS) {
  test(`a ${run.runner} run is one count line, its failure under it with its place and error`, async ($, on) => {
    engine(on)
    const ui = await result($, `Exit code 1\n${run.output}`, true)
    const shown = await texts(ui)

    expect(shown.slice(0, run.seconds === undefined ? 4 : 5)).toEqual(['  ⎿  ', '✗ 1 failed', ' · ', '✓ 1 passed', ...(run.seconds === undefined ? [] : [run.seconds])])
    expect(shown).toContain(run.name)
    expect(shown).toContain(`  ${run.at}`)
    for (const line of run.error) {
      expect(shown).toContain(`  ${line}`)
    }
    // No stack frame, code frame or hint line is taken for the error.
    expect(shown.some(text => /^\s+(at |\d+ ?\||>\s+\d+ \||note: )/.test(text))).toBe(false)
    await ui.unmount()
  })
}

test('a run with no failure reads from RTK\'s one line too', async ($, on) => {
  engine(on)
  for (const [output, count] of [
    ['cargo test: 1 passed, 1 filtered out (1 suite, 0.00s)', ['✓ 1 passed', ' · 0.0s']],
    ['Pytest: 1 passed in 0.00s', ['✓ 1 passed', ' · 0.0s']],
    ['Go test: 1 passed in 1 packages', ['✓ 1 passed']],
    ['PASS (1) FAIL (0) skipped (1)', ['✓ 1 passed']],
    ['SUMMARY:\n   1 pass\n   0 fail\n  Ran 1 test across 1 file. [2.00ms]', ['✓ 1 passed', ' · 0.0s']],
  ] as const) {
    const ui = await result($, { stdout: output, stderr: '', interrupted: false })
    expect((await texts(ui)).slice(1, 1 + count.length)).toEqual([...count])
    await ui.unmount()
  }
})

test('go test without -v names no passing test, so its output is the engine\'s', async ($, on) => {
  engine(on)
  const ui = await result($, `Exit code 1\n--- FAIL: TestBreaks (0.00s)\n    a_test.go:4: got 4, want 5\nFAIL\nFAIL\tgt\t0.513s\nFAIL`, true)

  expect(await ui.find({ type: 'Text' })).toBeUndefined()
  await ui.unmount()
})

// cargo test --no-fail-fast with a unit test binary and an integration test binary, each with one failure, and doc-tests.
const CARGO_TWO = [
  '     Running unittests src/lib.rs (target/debug/deps/rs-8457387f435de152)',
  '',
  'running 2 tests',
  'test tests::adds ... ok',
  'test tests::breaks ... FAILED',
  '',
  'failures:',
  '',
  '---- tests::breaks stdout ----',
  '',
  "thread 'tests::breaks' (13014276) panicked at src/lib.rs:8:19:",
  'assertion `left == right` failed: two and two',
  '  left: 4',
  ' right: 5',
  'note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace',
  '',
  '',
  'failures:',
  '    tests::breaks',
  '',
  'test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
  '',
  'error: test failed, to rerun pass `--lib`',
  '     Running tests/it.rs (target/debug/deps/it-d219c022df65a5e9)',
  '',
  'running 2 tests',
  'test outside ... ok',
  'test outside_breaks ... FAILED',
  '',
  'failures:',
  '',
  '---- outside_breaks stdout ----',
  '',
  "thread 'outside_breaks' (13014286) panicked at tests/it.rs:4:23:",
  'one and one',
  'note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace',
  '',
  '',
  'failures:',
  '    outside_breaks',
  '',
  'test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
  '',
  'error: test failed, to rerun pass `--test it`',
  '   Doc-tests rs',
  '',
  'running 0 tests',
  '',
  'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
  '',
  'error: 2 targets failed:',
  '    `--lib`',
  '    `--test it`',
].join('\n')
const CARGO_TWO_RTK = [
  '---- tests::breaks stdout ----',
  '',
  "thread 'tests::breaks' (13014316) panicked at src/lib.rs:8:19:",
  'assertion `left == right` failed: two and two',
  '  left: 4',
  ' right: 5',
  'note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace',
  '',
  '',
  '---- outside_breaks stdout ----',
  '',
  "thread 'outside_breaks' (13014319) panicked at tests/it.rs:4:23:",
  'one and one',
  'note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace',
  '',
  '',
  'test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
  'test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
  'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
  '[full output: "$HOME/Library/Application Support/rtk/tee/1792514853_cargo_test.log"]',
].join('\n')

test('several cargo test binaries are summed, each failure under the one count line', async ($, on) => {
  engine(on)
  for (const output of [CARGO_TWO, CARGO_TWO_RTK]) {
    const ui = await result($, `Exit code 101\n${output}`, true)
    const shown = await texts(ui)

    expect(shown.slice(0, 4)).toEqual(['  ⎿  ', '✗ 2 failed', ' · ', '✓ 2 passed'])
    expect(shown).toContain('tests::breaks')
    expect(shown).toContain('  src/lib.rs:8')
    expect(shown).toContain('outside_breaks')
    expect(shown).toContain('  tests/it.rs:4')
    expect(shown).toContain('  one and one')
    // The run's closing `error:` lines are not taken for the last failure's error.
    expect(shown.some(text => text.includes('targets failed') || text.includes('`--test it`'))).toBe(false)
    await ui.unmount()
  }
})

// go test -v with subtests, and with parallel tests whose logs interleave.
const GO_SUBTESTS = [
  '=== RUN   TestAdds',
  '--- PASS: TestAdds (0.00s)',
  '=== RUN   TestBreaks',
  '    a_test.go:4: got 4, want 5',
  '--- FAIL: TestBreaks (0.00s)',
  '=== RUN   TestTable',
  '=== RUN   TestTable/one',
  '=== RUN   TestTable/two',
  '    b_test.go:5: two is 3',
  '--- FAIL: TestTable (0.00s)',
  '    --- PASS: TestTable/one (0.00s)',
  '    --- FAIL: TestTable/two (0.00s)',
  'FAIL',
  'FAIL\tgt\t0.258s',
  'FAIL',
].join('\n')
const GO_PARALLEL = [
  '=== RUN   TestSlow',
  '=== PAUSE TestSlow',
  '=== RUN   TestQuick',
  '=== PAUSE TestQuick',
  '=== RUN   TestFine',
  '=== PAUSE TestFine',
  '=== CONT  TestSlow',
  '=== CONT  TestQuick',
  '=== CONT  TestFine',
  '=== NAME  TestQuick',
  '    p_test.go:4: quick says hi',
  '    p_test.go:4: quick broke',
  '=== NAME  TestFine',
  '    p_test.go:5: fine says hi',
  '--- FAIL: TestQuick (0.00s)',
  '--- PASS: TestFine (0.00s)',
  '=== NAME  TestSlow',
  '    p_test.go:3: slow broke',
  '--- FAIL: TestSlow (0.05s)',
  'FAIL',
  'FAIL\tgp\t0.323s',
  'FAIL',
].join('\n')

/** Each failure as drawn: its name, then the lines under it up to the next. */
const failuresOf = (shown: string[]) => {
  const drawn: Record<string, string[]> = {}
  let name = ''
  shown.forEach((text, index) => {
    if (shown[index - 1] === '✗ ') {
      name = text
      drawn[name] = []
    } else if (name !== '' && text !== '✗ ') {
      drawn[name]!.push(text)
    }
  })

  return drawn
}

test("a go test's log is the test's that wrote it, with subtests and parallel tests", async ($, on) => {
  engine(on)
  const subtests = await result($, `Exit code 1\n${GO_SUBTESTS}`, true)
  const shown = await texts(subtests)
  expect(shown.slice(0, 4)).toEqual(['  ⎿  ', '✗ 3 failed', ' · ', '✓ 2 passed'])
  expect(failuresOf(shown)).toEqual({
    TestBreaks: ['  a_test.go:4', '  got 4, want 5'],
    // The parent failed by its subtest: the subtest's log is not its own.
    TestTable: [],
    'TestTable/two': ['  b_test.go:5', '  two is 3'],
  })
  await subtests.unmount()

  const parallel = await result($, `Exit code 1\n${GO_PARALLEL}`, true)
  expect(failuresOf(await texts(parallel))).toEqual({
    TestQuick: ['  p_test.go:4', '  quick says hi', '  quick broke'],
    TestSlow: ['  p_test.go:3', '  slow broke'],
  })
  await parallel.unmount()
})

test('pytest -v names its passing tests, and show passed lists them', async ($, on) => {
  engine(on)
  const verbose = PYTEST.replace('test_a.py .F                                                             [100%]', [
    'test_a.py::test_adds PASSED                                              [ 50%]',
    'test_a.py::test_breaks FAILED                                            [100%]',
  ].join('\n'))
  const ui = await result($, `Exit code 1\n${verbose}`, true)

  await ui.press({ key: 'passed:run' })
  expect(await texts(ui)).toContain('test_a.py::test_adds')
  await ui.unmount()
})

test('a pytest collection error counts as a failure, with its error', async ($, on) => {
  engine(on)
  const errored = [
    '============================= test session starts ==============================',
    'collected 1 item / 1 error',
    '',
    '==================================== ERRORS ====================================',
    '_______________________ ERROR collecting test_broken.py ________________________',
    "ImportError while importing test module '/work/pe/test_broken.py'.",
    'Hint: make sure your test modules/packages have valid Python names.',
    'Traceback:',
    '/opt/homebrew/lib/python3.14/importlib/__init__.py:88: in import_module',
    '    return _bootstrap._gcd_import(name[level:], package, level)',
    'test_broken.py:1: in <module>',
    '    import nosuchmodule',
    "E   ModuleNotFoundError: No module named 'nosuchmodule'",
    '=========================== short test summary info ============================',
    'ERROR test_broken.py',
    '!!!!!!!!!!!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!!!!!!!!!!!',
    '=============================== 1 error in 0.06s ===============================',
  ].join('\n')
  const ui = await result($, `Exit code 2\n${errored}`, true)
  const shown = await texts(ui)

  expect(shown.slice(0, 4)).toEqual(['  ⎿  ', '✗ 1 failed', ' · ', '✓ 0 passed'])
  expect(shown).toContain('ERROR collecting test_broken.py')
  expect(shown).toContain("  ModuleNotFoundError: No module named 'nosuchmodule'")
  await ui.unmount()
})

// jest with two failures, one a thrown error, and a console.log above them; RTK's form of the same run.
const JEST_TWO = [
  '  console.log',
  '    about to throw',
  '',
  '      at Object.<anonymous> (j2/b.test.cjs:3:32)',
  '',
  'FAIL j2/b.test.cjs',
  '  ● breaks',
  '',
  '    expect(received).toBe(expected) // Object.is equality',
  '',
  '    Expected: 5',
  '    Received: 4',
  '',
  "      1 | test('adds', () => { expect(1 + 2).toBe(3) })",
  "    > 2 | test('breaks', () => { expect(2 + 2).toBe(5) })",
  '        |                                      ^',
  '      3 |',
  '',
  '      at Object.<anonymous> (j2/b.test.cjs:2:38)',
  '',
  '  ● throws',
  '',
  '    kaboom',
  '',
  "    > 3 | test('throws', () => { console.log('about to throw'); throw new Error('kaboom') })",
  '        |                                                             ^',
  '      4 |',
  '',
  '      at Object.<anonymous> (j2/b.test.cjs:3:61)',
  '',
  'Test Suites: 1 failed, 1 total',
  'Tests:       2 failed, 1 passed, 3 total',
  'Snapshots:   0 total',
  'Time:        0.119 s',
  'Ran all test suites matching j2.',
].join('\n')
const JEST_TWO_RTK = [
  'PASS (1) FAIL (2)',
  '',
  '1. breaks',
  '   Error: expect(received).toBe(expected) // Object.is equality',
  '   ',
  '   Expected: 5',
  '   Received: 4',
  '       at Object.<anonymous> (/work/js/j2/b.test.cjs:2:38)',
  '       at Promise.finally.completed (/work/js/node_modules/jest-circus/build/jestAdapterInit.js:1834:28)',
  '2. throws',
  '   Error: kaboom',
  '       at Object.<anonymous> (/work/js/j2/b.test.cjs:3:61)',
  '       at new Promise (<anonymous>)',
  '[full output: "$HOME/Library/Application Support/rtk/tee/1792514915_jest_run.log"]',
].join('\n')

test('several jest failures each keep their own error and place, in its form and RTK\'s', async ($, on) => {
  engine(on)
  for (const [output, error, places] of [
    [JEST_TWO, ['  expect(received).toBe(expected) // Object.is equality', '  ', '  Expected: 5', '  Received: 4'], ['  j2/b.test.cjs:2', '  j2/b.test.cjs:3']],
    [JEST_TWO_RTK, ['  Error: expect(received).toBe(expected) // Object.is equality', '  ', '  Expected: 5', '  Received: 4'], ['  /work/js/j2/b.test.cjs:2', '  /work/js/j2/b.test.cjs:3']],
  ] as const) {
    const ui = await result($, `Exit code 1\n${output}`, true)
    const shown = await texts(ui)
    const failures = failuresOf(shown)

    expect(shown.slice(0, 4)).toEqual(['  ⎿  ', '✗ 2 failed', ' · ', '✓ 1 passed'])
    expect(Object.keys(failures)).toEqual(['breaks', 'throws'])
    expect(failures.breaks).toEqual([places[0], ...error])
    expect(failures.throws?.[0]).toBe(places[1])
    expect(failures.throws?.some(text => text.endsWith('kaboom'))).toBe(true)
    // The console.log above the failures is no failure's.
    expect(shown.some(text => text.includes('about to throw'))).toBe(false)
    await ui.unmount()
  }
})

test('a vitest run with no failure is its count alone', async ($, on) => {
  engine(on)
  const passing = [
    '',
    ' RUN  v5.0.5 /work/js',
    '',
    '',
    ' Test Files  1 passed (1)',
    '      Tests  2 passed (2)',
    '   Start at  00:48:35',
    '   Duration  148ms (transform 51%, import 30%, worker 11%, tests 7%)',
    '',
  ].join('\n')
  const ui = await result($, { stdout: passing, stderr: '', interrupted: false })

  expect(await texts(ui)).toEqual(['  ⎿  ', '✓ 2 passed', ' · 0.1s', '    ', '  '])
  await ui.unmount()
})

test('output that only brushes a runner\'s form is the engine\'s to draw', async ($, on) => {
  engine(on)
  for (const output of [
    // git log, a message naming a runner's summary.
    'commit 4c8cd0f\nAuthor: Nate <nate@example.com>\n\n    Read the test result: line of cargo\n\n    Tests: count jest\'s total',
    // ls of a tests folder.
    'a.test.ts\nb_test.go\ntest_a.py\ntests',
    // A doc with aligned columns and a numbered list.
    '## Layout\n\n  Tests  live next to the code they test.\n  Docs   live in docs/.\n\n1. Run the tests.\n2. Read the failures.',
    // A README that quotes a summary line in prose.
    'Jest prints a line like\nTests: one per file, then the total\nunder each run.',
    // RTK when it cannot read vitest 5: no counts at all.
    '[RTK:PASSTHROUGH] vitest parser: All parsing tiers failed\nJSON report written to /work/js/.vitest/json/output.json',
  ]) {
    const ui = await result($, { stdout: output, stderr: '', interrupted: false })
    expect(await ui.find({ type: 'Text' })).toBeUndefined()
    await ui.unmount()
  }
})

for (const [option, runner, output] of [
  ['cargoTest', 'cargo test', CARGO],
  ['goTest', 'go test', GO],
  ['pytest', 'pytest', PYTEST],
  ['vitestJest', 'vitest', VITEST],
  ['vitestJest', 'jest', JEST],
  ['vitestJest', 'RTK jest and vitest', JEST_RTK],
] as const) {
  test(`with ${option} off a ${runner} run is the engine's to draw`, { options: { [option]: false } }, async ($, on) => {
    engine(on)
    const ui = await result($, `Exit code 1\n${output}`, true)

    expect(await ui.find({ type: 'Text' })).toBeUndefined()
    await ui.unmount()
  })
}
