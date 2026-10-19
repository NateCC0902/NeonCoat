import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Unfolded } from '../types'

const unfolded = atom({ plugin: 'test-summary', key: 'unfolded' } as const, {} as Record<string, Unfolded>)

// What one failure shows of its error; the whole output is a press away.
const DETAIL_LINES = 12
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

  return kept.slice(0, DETAIL_LINES)
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

/** The run a command's output is, by the first reader that knows its form. */
const summarize = (text: string) => {
  const lines = text.replace(ESCAPES, '').split('\n').map(line => line.replace(/\r$/, ''))

  return node(lines) ?? bun(lines) ?? tsc(lines)
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

export const register: Register = (on, options) => {
  if (options.enabled === false) {
    return
  }

  on('ui.render', { component: 'ToolResult', props: { tool: 'Bash' } }, async ($, e, next) => {
    const output = e.props.output as { interrupted?: boolean } | string | undefined
    const summary = e.surface === 'terminal' && typeof output !== 'undefined' && !(typeof output === 'object' && output.interrupted)
      ? summarize(outputText(output))
      : undefined
    if (summary === undefined) {
      return next(e)
    }

    const id = e.props.tool_use_id
    const shown = (await read($, unfolded))[id] ?? {}
    const toggle = (key: keyof Unfolded) => () =>
      update($, unfolded, all => ({ ...all, [id]: { ...all[id], [key]: !all[id]?.[key] } }))
    const { Box, Text, Button } = $.ui.resolve(e)
    const failed = summary.kind === 'tests' ? summary.failed : summary.failures.length

    const count =
      summary.kind === 'types' ? (
        <Text color="error" bold>
          ✗ {plural(failed, 'type error')}
        </Text>
      ) : (
        <>
          {failed > 0 && (
            <Text color="error" bold>
              ✗ {failed} failed
            </Text>
          )}
          {failed > 0 && <Text dimColor> · </Text>}
          <Text color="success" bold={failed === 0}>
            ✓ {summary.passedCount} passed
          </Text>
          {summary.seconds !== undefined && <Text dimColor> · {summary.seconds.toFixed(1)}s</Text>}
        </>
      )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text dimColor>{'  ⎿  '}</Text>
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
              {failure.at !== undefined && <Text dimColor>{`  ${failure.at}`}</Text>}
              {failure.detail.map(line => (
                <Text color={line.startsWith('+') ? 'success' : line.startsWith('-') ? 'error' : undefined}>{`  ${line}`}</Text>
              ))}
            </Box>
          ))}
          {summary.kind === 'tests' && shown.isPassedShown && (
            <Box flexDirection="column" marginTop={1}>
              {summary.passed.map(test => (
                <Box flexDirection="row">
                  <Text color="success">✓ </Text>
                  <Text dimColor>{test.ms === undefined ? test.name : `${test.name} (${Math.round(test.ms)}ms)`}</Text>
                </Box>
              ))}
            </Box>
          )}
        </Box>
        {shown.isOutputShown && (await next(e))}
      </Box>
    )
  })
}
