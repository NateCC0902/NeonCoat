import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register } from 'claude-code'

import type { Unfolded } from '../types'

const unfolded = atom({ plugin: 'test-summary', key: 'unfolded' } as const, {} as Record<string, Unfolded>)

// The most a failure keeps of its error, its stack left out: the `failureLines`
// option shows fewer, copy failures copies these, the whole output is a press away.
const DETAIL_LIMIT = 100
// Color codes and cursor moves, which a row would draw as junk.
const ESCAPES = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

type Test = { name: string; ms?: number }
type Failure = { name: string; at?: string; detail: string[] }
/**
 * A run read from its output: tests that passed and failed, or type errors.
 * The counts are the runner's own: node lists a suite's own ✔ line among its tests.
 */
type Summary =
  | { kind: 'tests'; passed: Test[]; passedCount: number; failures: Failure[]; failed: number; seconds?: number }
  | { kind: 'types'; failures: Failure[] }

// RTK (a hook that rewrites `cargo test` to `rtk cargo test` and the like) prints a
// compact form of its own: a runner's reader knows both, the RTK one noted as such.
const NODE_RESULT = /^\s*(✔|✖) (.+?)(?: \(([\d.]+)ms\))?$/
const NODE_COUNT = /^ℹ (pass|fail|duration_ms) ([\d.]+)$/
const BUN_RESULT = /^\s*\((pass|fail)\) (.+?)(?: \[([\d.]+)(m?s)\])?$/
const BUN_COUNT = /^\s*(\d+) (pass|fail)$/
const BUN_RAN = /^\s*Ran \d+ tests? across \d+ files?\. \[([\d.]+)(m?s)\]$/
const TSC_ERROR = /^(.+?)\((\d+),\d+\): error TS\d+: (.*)$/
const CARGO_TEST = /^test (.+) \.\.\. (ok|FAILED)$/
const CARGO_RESULT = /^test result: \w+\. (\d+) passed; (\d+) failed;.* finished in ([\d.]+)s$/
// RTK, for a run with no failure.
const CARGO_RTK = /^cargo test: (\d+) passed\b.*?([\d.]+)s\)$/
const CARGO_FAILURE = /^---- (.+) stdout ----$/
const CARGO_PANIC = /panicked at (.+?):(\d+):\d+:$/
const GO_RUN = /^=== RUN\s/
// The test a log line under it is from: parallel tests and subtests interleave theirs.
const GO_HEADER = /^=== (?:RUN|CONT|NAME)\s+(\S+)/
const GO_RESULT = /^\s*--- (PASS|FAIL): (\S+) \(([\d.]+)s\)$/
const GO_LOG = /^\s*(\S+\.go):(\d+): (.*)$/
const GO_RTK = /^Go test: (.+) in \d+ packages?$/
const GO_RTK_FAILURE = /^\s+\[FAIL\] (.+)$/
const PYTEST_TOTAL = /^=+ (.*\d+ (?:passed|failed|errors?).*?) in ([\d.]+)s(?: \([\d:]+\))? =+$/
const PYTEST_RTK = /^Pytest: (.+) in ([\d.]+)s$/
const PYTEST_PASSED = /^(\S+::\S+) PASSED\b/
const PYTEST_FAILURE = /^_{3,} (.+?) _{3,}$/
const PYTEST_RTK_FAILURE = /^\d+\. \[FAIL\] (.+)$/
const PYTEST_AT = /^(\S+?):(\d+): /
const VITEST_TESTS = /^\s+Tests {2}((?:\d+ \w+(?: \| )?)+) \(\d+\)$/
const VITEST_DURATION = /^\s+Duration {2}([\d.]+)(m?s)\b/
const VITEST_FAILURE = /^ FAIL {2}(.+?)(?: > (.+))?$/
const VITEST_AT = /^\s*❯ (.+?):(\d+):\d+$/
const JEST_TESTS = /^Tests:\s+((?:\d+ \w+, )*\d+ total)$/
const JEST_TIME = /^Time:\s+([\d.]+) s\b/
const JEST_FAILURE = /^ {2}● (.+)$/
// RTK, the same for vitest and jest.
const JS_RTK = /^PASS \((\d+)\) FAIL \((\d+)\)/
const JS_RTK_FAILURE = /^\d+\. (.+)$/
const STACK_AT = /^\s*at (?:.*\()?(?:file:\/\/)?([^\s()]+?):(\d+):\d+\)?$/
// A code frame's numbered lines and its caret, which say no more than `at`.
const CODE_FRAME = /^\s*>?\s*\d+ \||^\s+\||^\s*\^$/

/** A failure's error as shown: its first lines, the stack and leading and trailing blanks gone. */
const detail = (lines: string[]) => {
  const until = lines.findIndex(line => /^\s+at /.test(line))
  const kept = (until === -1 ? lines : lines.slice(0, until)).map(line => line.replace(/^ {2}/, ''))
  while (kept.length > 0 && kept.at(-1)!.trim() === '') {
    kept.pop()
  }
  while (kept.length > 0 && kept[0]!.trim() === '') {
    kept.shift()
  }

  return kept.slice(0, DETAIL_LIMIT)
}

/** The lines after `at`, up to the first that `isEnd` holds for. */
const block = (lines: string[], at: number, isEnd: (line: string) => boolean) => {
  const end = lines.findIndex((line, index) => index > at && isEnd(line))

  return lines.slice(at + 1, end === -1 ? undefined : end)
}

/** The first stack frame's place, as `file:line`. */
const stackAt = (lines: string[]) => {
  const place = lines.map(line => STACK_AT.exec(line)).find(match => match !== null)

  return place === undefined ? undefined : `${place[1]}:${place[2]}`
}

/** How many `word` a count line such as `1 failed, 2 passed` gives. */
const tally = (text: string, word: string) => Number(new RegExp(`(\\d+) ${word}`).exec(text)?.[1] ?? 0)

/** `node --test`'s spec reporter: ✔ and ✖ lines, ℹ counts, then the failures again with their errors. */
function node(lines: string[]): Summary | undefined {
  const failingAt = lines.findIndex(line => line.trim() === '✖ failing tests:')
  const results = failingAt === -1 ? lines : lines.slice(0, failingAt)
  const counts: Record<string, number> = {}
  const passed: Test[] = []
  const failures: Failure[] = []

  for (const line of results) {
    const count = NODE_COUNT.exec(line)
    if (count) {
      counts[count[1]!] = Number(count[2])
    }
    const result = NODE_RESULT.exec(line)
    if (result && result[1] === '✔') {
      passed.push({ name: result[2]!, ms: result[3] === undefined ? undefined : Number(result[3]) })
    } else if (result && failingAt === -1) {
      failures.push({ name: result[2]!, detail: [] })
    }
  }
  if (counts.pass === undefined) {
    return undefined
  }

  // Each failure again: `test at <where>`, its ✖ line, its error, its stack.
  for (let at = failingAt + 1; failingAt !== -1 && at < lines.length; at += 1) {
    const where = /^test at (.+)$/.exec(lines[at]!)
    const result = NODE_RESULT.exec(lines[at + 1] ?? '')
    if (!where || !result) {
      continue
    }
    const end = lines.findIndex((line, index) => index > at + 1 && line.startsWith('test at '))
    failures.push({
      name: result[2]!,
      at: where[1]!.replace(/^file:\/\//, ''),
      detail: detail(lines.slice(at + 2, end === -1 ? undefined : end)),
    })
  }

  return {
    kind: 'tests',
    passed,
    passedCount: counts.pass,
    failures,
    failed: counts.fail ?? failures.length,
    seconds: counts.duration_ms === undefined ? undefined : counts.duration_ms / 1000,
  }
}

/** A bun failure's error: indented under its (fail) line by claude plugin test and RTK, printed before it by bun itself. */
const bunFailure = (lines: string[], at: number, name: string): Failure => {
  const after = lines[at + 1] ?? ''
  let body: string[]
  if (/^\s+\S/.test(after) && !BUN_COUNT.test(after) && !BUN_RESULT.test(after)) {
    const indent = after.search(/\S/)
    body = block(lines, at, next => BUN_RESULT.test(next) || BUN_COUNT.test(next) || (next.trim() !== '' && next.search(/\S/) < indent))
  } else {
    // Back to the test before it, or its file's `name.test.ts:` line.
    const from = lines.findLastIndex((line, index) => index < at && (BUN_RESULT.test(line) || /^\S+:$/.test(line)))
    body = lines.slice(from + 1, at).filter(line => !CODE_FRAME.test(line))
  }

  return { name, at: stackAt(body), detail: detail(body) }
}

/** `bun test` and `claude plugin test`, and RTK's bun: (pass) and (fail) lines, the pass and fail counts. */
function bun(lines: string[]): Summary | undefined {
  const passed: Test[] = []
  const failures: Failure[] = []
  const counts: Record<string, number> = {}
  let seconds: number | undefined

  lines.forEach((line, at) => {
    const count = BUN_COUNT.exec(line)
    if (count) {
      counts[count[2]!] = Number(count[1])
    }
    const ran = BUN_RAN.exec(line)
    if (ran) {
      seconds = Number(ran[1]) / (ran[2] === 'ms' ? 1000 : 1)
    }
    const result = BUN_RESULT.exec(line)
    if (!result) {
      return
    }
    const ms = result[3] === undefined ? undefined : Number(result[3]) * (result[4] === 's' ? 1000 : 1)
    if (result[1] === 'pass') {
      passed.push({ name: result[2]!, ms })

      return
    }
    failures.push(bunFailure(lines, at, result[2]!))
  })
  if (seconds === undefined && passed.length + failures.length === 0) {
    return undefined
  }

  // RTK lists only the failures: its counts say how many passed.
  return { kind: 'tests', passed, passedCount: counts.pass ?? passed.length, failures, failed: counts.fail ?? failures.length, seconds }
}

/** `tsc`: one `file(line,col): error TS…` line per error, its continuation indented under it. */
function tsc(lines: string[]): Summary | undefined {
  const failures: Failure[] = []
  for (const line of lines) {
    const error = TSC_ERROR.exec(line)
    if (error) {
      failures.push({ name: error[3]!, at: `${error[1]}:${error[2]}`, detail: [] })
    } else if (failures.length > 0 && /^\s/.test(line) && line.trim() !== '') {
      failures.at(-1)!.detail.push(line.trim())
    }
  }

  return failures.length === 0 ? undefined : { kind: 'types', failures }
}

/** `cargo test`: a `test result:` line per test binary, each failure's `---- name stdout ----` with its panic; RTK's one line when all passed. */
function cargo(lines: string[]): Summary | undefined {
  const totals = lines.map(line => CARGO_RESULT.exec(line)).filter(match => match !== null)
  const short = lines.map(line => CARGO_RTK.exec(line)).find(match => match !== null)
  if (totals.length === 0 && short === undefined) {
    return undefined
  }
  const passed = lines
    .map(line => CARGO_TEST.exec(line))
    .filter(match => match?.[2] === 'ok')
    .map(match => ({ name: match![1]! }))
  const failures = lines.flatMap((line, at): Failure[] => {
    const failure = CARGO_FAILURE.exec(line)
    if (!failure) {
      return []
    }
    const body = block(lines, at, next => CARGO_FAILURE.test(next) || next === 'failures:' || next.startsWith('test result: '))
    const panic = body.map(each => CARGO_PANIC.exec(each)).find(match => match !== null)
    const said = body.filter(each => each.trim() !== '' && !CARGO_PANIC.test(each) && !each.startsWith('note: '))

    return [{ name: failure[1]!, at: panic && `${panic[1]}:${panic[2]}`, detail: said.slice(0, DETAIL_LIMIT) }]
  })
  if (totals.length === 0) {
    return { kind: 'tests', passed, passedCount: Number(short![1]), failures, failed: failures.length, seconds: Number(short![2]) }
  }
  const sum = (index: number) => totals.reduce((total, match) => total + Number(match[index]), 0)

  return { kind: 'tests', passed, passedCount: sum(1), failures, failed: sum(2), seconds: sum(3) }
}

/** A Go test's failure from its log lines (`file.go:N: message`), at the place of the first. */
const goFailure = (name: string, body: string[]): Failure => {
  const logs = body.map(line => GO_LOG.exec(line))
  const first = logs.find(match => match !== null)

  return {
    name,
    at: first && `${first[1]}:${first[2]}`,
    detail: body.map((line, index) => logs[index]?.[3] ?? line.trim()).filter(line => line !== '').slice(0, DETAIL_LIMIT),
  }
}

/** `go test -v`: RUN, PASS and FAIL lines, a failure's log between its RUN and FAIL; RTK's counts with each [FAIL] and its log. */
function go(lines: string[]): Summary | undefined {
  const total = lines.map(line => GO_RTK.exec(line)).find(match => match !== null)
  if (total) {
    const failures = lines.flatMap((line, at) => {
      const failure = GO_RTK_FAILURE.exec(line)

      return failure ? [goFailure(failure[1]!, block(lines, at, next => !/^ {3}/.test(next)))] : []
    })

    return { kind: 'tests', passed: [], passedCount: tally(total[1]!, 'passed'), failures, failed: tally(total[1]!, 'failed') }
  }
  // shortcut: without -v go names no passing test, so its output is left to the engine; read `go test -json` if that matters.
  if (!lines.some(line => GO_RUN.test(line))) {
    return undefined
  }
  const passed: Test[] = []
  const failures: Failure[] = []
  const logs: Record<string, string[]> = {}
  let current = ''
  for (const line of lines) {
    const header = GO_HEADER.exec(line)
    const result = GO_RESULT.exec(line)
    if (header) {
      current = header[1]!
    } else if (result?.[1] === 'PASS') {
      passed.push({ name: result[2]!, ms: Number(result[3]) * 1000 })
    } else if (result) {
      failures.push(goFailure(result[2]!, logs[result[2]!] ?? []))
    } else if (/^\s/.test(line)) {
      (logs[current] ??= []).push(line)
    }
  }
  if (passed.length + failures.length === 0) {
    return undefined
  }

  return { kind: 'tests', passed, passedCount: passed.length, failures, failed: failures.length }
}

/** A pytest failure from its traceback: the place of its first frame, its `E` lines. */
const pytestFailure = (name: string, body: string[]): Failure => {
  const place = body.map(line => PYTEST_AT.exec(line.trim())).find(match => match !== null)

  return {
    name,
    at: place && `${place[1]}:${place[2]}`,
    detail: body
      .map(line => /^\s*E\s+(.*)$/.exec(line)?.[1])
      .filter(line => line !== undefined)
      .slice(0, DETAIL_LIMIT),
  }
}

/** pytest: its `= 1 failed, 2 passed in 0.1s =` line, each failure's `___ name ___` traceback; RTK's `Pytest:` line and numbered failures. */
function pytest(lines: string[]): Summary | undefined {
  const total = lines.map(line => PYTEST_TOTAL.exec(line) ?? PYTEST_RTK.exec(line)).find(match => match !== null)
  if (total === undefined) {
    return undefined
  }
  const passed = lines
    .map(line => PYTEST_PASSED.exec(line))
    .filter(match => match !== null)
    .map(match => ({ name: match[1]! }))
  const failures = lines.flatMap((line, at) => {
    const failure = PYTEST_FAILURE.exec(line)
    const short = PYTEST_RTK_FAILURE.exec(line)
    if (failure) {
      return [pytestFailure(failure[1]!, block(lines, at, next => PYTEST_FAILURE.test(next) || /^=+ /.test(next)))]
    }

    return short ? [pytestFailure(short[1]!, block(lines, at, next => !/^\s/.test(next)))] : []
  })

  return {
    kind: 'tests',
    passed,
    passedCount: tally(total[1]!, 'passed'),
    failures,
    failed: tally(total[1]!, 'failed') + tally(total[1]!, 'error'),
    seconds: Number(total[2]),
  }
}

/** vitest: its `Tests  1 failed | 2 passed` line, each failure's ` FAIL  file > name` with its error up to `❯ file:line`. */
function vitest(lines: string[]): Summary | undefined {
  const total = lines.map(line => VITEST_TESTS.exec(line)).find(match => match !== null)
  if (total === undefined) {
    return undefined
  }
  const duration = lines.map(line => VITEST_DURATION.exec(line)).find(match => match !== null)
  const failures = lines.flatMap((line, at) => {
    const failure = VITEST_FAILURE.exec(line)
    if (!failure) {
      return []
    }
    const body = block(lines, at, next => VITEST_AT.test(next) || next.startsWith('⎯') || VITEST_FAILURE.test(next))
    const place = VITEST_AT.exec(lines[at + 1 + body.length] ?? '')

    return [{ name: failure[2] ?? failure[1]!, at: place ? `${place[1]}:${place[2]}` : undefined, detail: detail(body) }]
  })

  return {
    kind: 'tests',
    passed: [],
    passedCount: tally(total[1]!, 'passed'),
    failures,
    failed: tally(total[1]!, 'failed'),
    seconds: duration && Number(duration[1]) / (duration[2] === 'ms' ? 1000 : 1),
  }
}

/** jest: its `Tests: 1 failed, 2 passed, 3 total` line, each failure's `● name` with its error and stack. */
function jest(lines: string[]): Summary | undefined {
  const total = lines.map(line => JEST_TESTS.exec(line)).find(match => match !== null)
  if (total === undefined) {
    return undefined
  }
  const time = lines.map(line => JEST_TIME.exec(line)).find(match => match !== null)
  const failures = lines.flatMap((line, at) => {
    const failure = JEST_FAILURE.exec(line)
    // A test's console output is printed under a ● too.
    if (!failure || failure[1] === 'Console') {
      return []
    }
    const body = block(lines, at, next => JEST_FAILURE.test(next) || /^(PASS|FAIL) |^Test Suites:/.test(next)).map(each => each.replace(/^ {4}/, ''))

    return [{ name: failure[1]!, at: stackAt(body), detail: detail(body.filter(each => !CODE_FRAME.test(each))) }]
  })

  return {
    kind: 'tests',
    passed: [],
    passedCount: tally(total[1]!, 'passed'),
    failures,
    failed: tally(total[1]!, 'failed'),
    seconds: time && Number(time[1]),
  }
}

/** RTK's vitest and jest: `PASS (2) FAIL (1)`, then each failure numbered with its error and stack. */
function jsRtk(lines: string[]): Summary | undefined {
  const total = lines.map(line => JS_RTK.exec(line)).find(match => match !== null)
  if (total === undefined) {
    return undefined
  }
  const failures = lines.flatMap((line, at) => {
    const failure = JS_RTK_FAILURE.exec(line)
    if (!failure) {
      return []
    }
    const body = block(lines, at, next => /^\S/.test(next)).map(each => each.replace(/^ {3}/, ''))

    return [{ name: failure[1]!, at: stackAt(body), detail: detail(body) }]
  })

  return { kind: 'tests', passed: [], passedCount: Number(total[1]), failures, failed: Number(total[2]) }
}

type Reader = (lines: string[]) => Summary | undefined

/** The run a command's output is, by the first of the readers switched on that knows its form. */
const summarize = (text: string, readers: readonly Reader[]) => {
  const lines = text.replace(ESCAPES, '').split('\n').map(line => line.replace(/\r$/, ''))
  for (const reader of readers) {
    const summary = reader(lines)
    if (summary !== undefined) {
      return summary
    }
  }

  return undefined
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

const failureText = (summary: Summary) =>
  summary.failures
    .map(failure => [`✗ ${failure.name}`, ...(failure.at ? [`  ${failure.at}`] : []), ...failure.detail.map(line => `  ${line}`)].join('\n'))
    .join('\n\n')

/** The text a Bash call's result block draws from: the error the model read, or stdout and stderr. */
const outputText = (output: unknown) => {
  if (typeof output === 'string') {
    return output
  }
  const { stdout = '', stderr = '' } = (output ?? {}) as { stdout?: string; stderr?: string }

  return `${stdout}\n${stderr}`
}

type Run = { id: string; summary: Summary }

/** The run a Bash call's output reads as, once it has ended and unless an abort cut it. */
const runOf = (id: string | undefined, output: unknown, readers: readonly Reader[]): Run | undefined => {
  if (id === undefined || output === undefined || (typeof output === 'object' && (output as { interrupted?: boolean }).interrupted)) {
    return undefined
  }
  const summary = summarize(outputText(output), readers)

  return summary === undefined ? undefined : { id, summary }
}

/** A run's count line with its buttons, its failures under it. */
async function drawRun($: EngineInterface, { Box, Text, Button }: Elements['terminal'], { id, summary }: Run, failureLines: number) {
  const shown = (await read($, unfolded))[id] ?? {}
  const toggle = (key: keyof Unfolded) => () =>
    update($, unfolded, all => ({ ...all, [id]: { ...all[id], [key]: !all[id]?.[key] } }))
  const failed = summary.kind === 'tests' ? summary.failed : summary.failures.length

  const count =
    summary.kind === 'types' ? (
      <Text color="error" bold>
        ✗ {plural(failed, 'type error')}
      </Text>
    ) : (
      <Box flexDirection="row">
        {failed > 0 && (
          <Text color="error" bold>
            ✗ {failed} failed
          </Text>
        )}
        {failed > 0 && <Text color="subtle"> · </Text>}
        <Text color="success" bold={failed === 0}>
          ✓ {summary.passedCount} passed
        </Text>
        {summary.seconds !== undefined && <Text color="subtle"> · {summary.seconds.toFixed(1)}s</Text>}
      </Box>
    )

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color="subtle">{'  ⎿  '}</Text>
        {count}
        <Text>{'    '}</Text>
        {summary.kind === 'tests' && summary.passed.length > 0 && (
          <Button key={`passed:${id}`} plain dimColor label={shown.isPassedShown ? 'hide passed' : 'show passed'} onPress={toggle('isPassedShown')} />
        )}
        {summary.failures.length > 0 && <Text>{'  '}</Text>}
        {summary.failures.length > 0 && (
          <Button
            key={`copy:${id}`}
            plain
            dimColor
            label="copy failures"
            onPress={async press => {
              const copied = await $.ui.copy({ text: failureText(summary), surface: press.surface })
              $.ui.toast(copied.isCopied ? 'Copied' : `Not copied: ${copied.reason}`)
            }}
          />
        )}
        <Text>{'  '}</Text>
        <Button key={`output:${id}`} plain dimColor label={shown.isOutputShown ? 'hide output' : 'output'} onPress={toggle('isOutputShown')} />
      </Box>
      <Box flexDirection="column" paddingLeft={5}>
        {summary.failures.map(failure => (
          <Box flexDirection="column" marginTop={1}>
            <Box flexDirection="row">
              <Text color="error">✗ </Text>
              <Text bold>{failure.name}</Text>
            </Box>
            {failure.at !== undefined && <Text color="subtle">{`  ${failure.at}`}</Text>}
            {failure.detail.slice(0, failureLines).map(line => (
              <Text color={line.startsWith('+') ? 'success' : line.startsWith('-') ? 'error' : undefined}>{`  ${line}`}</Text>
            ))}
          </Box>
        ))}
        {summary.kind === 'tests' && shown.isPassedShown && (
          <Box flexDirection="column" marginTop={1}>
            {summary.passed.map(test => (
              <Box flexDirection="row">
                <Text color="success">✓ </Text>
                <Text color="subtle">{test.ms === undefined ? test.name : `${test.name} (${Math.round(test.ms)}ms)`}</Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  )
}

export const register: Register = (on, options) => {
  if (options.enabled === false) {
    return
  }
  // The runners switched on, read in this order; a run none knows is the engine's to draw.
  const readers = [
    options.nodeTest !== false && node,
    options.bunTest !== false && bun,
    options.tsc !== false && tsc,
    options.cargoTest !== false && cargo,
    options.goTest !== false && go,
    options.pytest !== false && pytest,
    options.vitestJest !== false && vitest,
    options.vitestJest !== false && jest,
    options.vitestJest !== false && jsRtk,
  ].filter(reader => reader !== false)
  const failureLines = Math.max(1, Number(options.failureLines) || 12)

  // A command standing alone: its result block, the engine's own a press away.
  on('ui.render', { component: 'ToolResult', props: { tool: 'Bash' } }, async ($, e, next) => {
    const run = e.surface === 'terminal' ? runOf(e.props.tool_use_id, e.props.output, readers) : undefined
    if (e.surface !== 'terminal' || run === undefined) {
      return next(e)
    }
    const elements = $.ui.resolve(e)
    const shown = (await read($, unfolded))[run.id] ?? {}

    return (
      <elements.Box flexDirection="column">
        {await drawRun($, elements, run, failureLines)}
        {shown.isOutputShown && (await next(e))}
      </elements.Box>
    )
  })

  // Commands the transcript folds into a count line (`Ran 2 shell commands`) draw no result block:
  // each run's summary goes under the line, and its output button unfolds the group.
  // An unfolded group (--verbose, ctrl+o) draws each output whole: left as it is.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const runs = e.props.calls
      .map(call => (call.tool === 'Bash' && !call.isInterrupted ? runOf(call.tool_use_id, call.output, readers) : undefined))
      .filter(run => run !== undefined)
    if (e.surface !== 'terminal' || e.props.isExpanded || runs.length === 0) {
      return next(e)
    }
    const elements = $.ui.resolve(e)
    const all = await read($, unfolded)
    const isOutputShown = runs.some(run => all[run.id]?.isOutputShown)
    const drawn = []
    for (const run of runs) {
      drawn.push(await drawRun($, elements, run, failureLines))
    }

    return (
      <elements.Box flexDirection="column">
        {await next(isOutputShown ? { ...e, props: { ...e.props, isExpanded: true } } : e)}
        {drawn}
      </elements.Box>
    )
  })
}
