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

const NODE_RESULT = /^\s*(✔|✖) (.+?)(?: \(([\d.]+)ms\))?$/
const NODE_COUNT = /^ℹ (pass|fail|duration_ms) ([\d.]+)$/
const BUN_RESULT = /^\((pass|fail)\) (.+?)(?: \[([\d.]+)(m?s)\])?$/
const BUN_RAN = /^Ran \d+ tests? across \d+ files?\. \[([\d.]+)(m?s)\]$/
const TSC_ERROR = /^(.+?)\((\d+),\d+\): error TS\d+: (.*)$/

/** A failure's error as shown: its first lines, the stack and trailing blanks gone. */
const detail = (lines: string[]) => {
  const until = lines.findIndex(line => /^\s+at /.test(line))
  const kept = (until === -1 ? lines : lines.slice(0, until)).map(line => line.replace(/^ {2}/, ''))
  while (kept.length > 0 && kept.at(-1)!.trim() === '') {
    kept.pop()
  }

  return kept.slice(0, DETAIL_LIMIT)
}

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

/** `bun test` and `claude plugin test`: (pass) and (fail) lines, a failure's error indented under it. */
function bun(lines: string[]): Summary | undefined {
  const passed: Test[] = []
  const failures: Failure[] = []
  let seconds: number | undefined

  lines.forEach((line, at) => {
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
    const end = lines.findIndex((next, index) => index > at && !/^\s|^$/.test(next))
    failures.push({ name: result[2]!, detail: detail(lines.slice(at + 1, end === -1 ? undefined : end)) })
  })
  if (passed.length + failures.length === 0) {
    return undefined
  }

  return { kind: 'tests', passed, passedCount: passed.length, failures, failed: failures.length, seconds }
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
