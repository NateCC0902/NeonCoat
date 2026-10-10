#!/usr/bin/env node
// Claude Code status line: one colored row built from the JSON Claude Code
// pipes in on stdin. Drawn between the prompt and the mode line.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const BAR = 12

// ponytail: copied from ~/.claude/themes/charm.json; read that file here
// instead if the theme starts changing.
const COLORS = {
  text: '236;235;240',
  dim: '162;160;173',
  green: '0;255;178',
  yellow: '245;239;52',
  red: '255;87;125',
  pink: '255;96;255',
  purple: '139;117;255',
  teal: '16;177;174',
  cyan: '0;164;255',
}

const paint = (text, color, isBold = false) =>
  `\x1b[${isBold ? '1;' : ''}38;2;${COLORS[color]}m${text}\x1b[0m`

const compact = n =>
  n >= 999_500
    ? `${(n / 1e6).toFixed(1)}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}k`
      : `${n}`

const shorten = path => {
  const home = homedir()
  const short = path.startsWith(home) ? `~${path.slice(home.length)}` : path
  const parts = short.split('/')

  return parts.length > 4 ? `…/${parts.slice(-2).join('/')}` : short
}

// `git status --porcelain --branch`: "## main...origin/main [ahead 1]", then
// one line per changed path. Outside a repository it still says so.
const git = cwd => {
  try {
    const out = execFileSync(
      'git',
      ['--no-optional-locks', 'status', '--porcelain', '--branch'],
      { cwd, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    const [head = '', ...changed] = out.split('\n').filter(Boolean)
    const branch = head
      .slice(3)
      .replace(/^No commits yet on /, '')
      .split('...')[0]

    return (
      paint(`⎇ ${branch}`, 'yellow') +
      (changed.length > 0
        ? paint(` ±${changed.length}`, 'red')
        : paint(' clean', 'dim'))
    )
  } catch {
    return paint('⎇ no git', 'dim')
  }
}

// Empty or cut-off input still draws a row: every field has a fallback.
const parse = text => {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

const input = parse(readFileSync(0, 'utf8'))
const context = input.context_window ?? {}
const usage = context.current_usage ?? {}
const cwd = input.workspace?.current_dir ?? input.cwd ?? process.cwd()

const percent = Math.round(context.used_percentage ?? 0)
const filled = Math.min(
  BAR,
  Math.max(Math.sign(percent), Math.round((percent / 100) * BAR)),
)
const tone = percent >= 90 ? 'red' : percent >= 70 ? 'yellow' : 'green'

const segments = [
  paint('ctx ', 'dim') +
    paint('━'.repeat(filled), tone) +
    paint('─'.repeat(BAR - filled), 'dim') +
    paint(` ${percent}%`, tone, true),
  paint(`$${(input.cost?.total_cost_usd ?? 0).toFixed(2)}`, 'pink', true),
  paint(input.model?.display_name ?? '?', 'purple', true) +
    (input.effort?.level ? paint(` ${input.effort.level}`, 'purple') : ''),
]

// ponytail: Claude Code hands over the last response's output tokens and the
// session's total API time, never a speed. So a small tally per session lives
// in the temp folder: each new response adds its tokens and the API time since
// the one before. API time spent elsewhere (subagents, titles) lands in the
// same tally, so this is an estimate; time the requests in a mod for the truth.
const speed = () => {
  const file = join(tmpdir(), `claude-statusline-${input.session_id}.json`)
  const apiMs = input.cost?.total_api_duration_ms ?? 0
  const output = context.total_output_tokens ?? 0
  const seen = `${context.total_input_tokens}:${output}`
  let tally

  try {
    tally = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    tally = { apiMs, seen, tokens: 0, ms: 0 }
    writeFileSync(file, JSON.stringify(tally))
  }

  if (apiMs > tally.apiMs) {
    if (seen !== tally.seen && output > 0) {
      tally.tokens += output
      tally.ms += apiMs - tally.apiMs
    }

    writeFileSync(file, JSON.stringify({ ...tally, apiMs, seen }))
  }

  return tally.ms > 0 ? Math.round((tally.tokens * 1000) / tally.ms) : undefined
}

const tokensPerSecond = speed()

if (tokensPerSecond !== undefined) {
  segments.push(paint(`${tokensPerSecond}`, 'text', true) + paint(' t/s', 'dim'))
}

segments.push(paint(shorten(cwd), 'teal'))

// Whole minutes until `at` (epoch seconds); zero or less once it has passed,
// NaN when there is no such time.
const minutesUntil = at => Math.ceil((at * 1000 - Date.now()) / 60_000)

// A day or more away is said in whole days, to the nearest one.
const days = minutes => {
  const count = Math.round(minutes / 1440)

  return `${count}day${count === 1 ? '' : 's'}`
}

const span = minutes =>
  minutes >= 1440
    ? days(minutes)
    : minutes >= 60
      ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
      : `${minutes}m`

// Once the prompt cache lapses, the next message pays for the whole context
// again: warned of in its last minutes, and said outright once it is cold.
const coldWarning = cache => {
  if (!cache.caching_observed) {
    return ''
  }

  const minutes = minutesUntil(cache.expires_at)

  if (cache.warm === false || minutes <= 0) {
    return paint(
      `  ⚠ cold · ${compact(cache.recache_tokens_if_cold ?? 0)} to rebuild`,
      'red',
      true,
    )
  }

  return minutes <= (cache.ttl === '5m' ? 1 : 5)
    ? paint(`  ⚠ cold in ${span(minutes)}`, 'yellow', true)
    : ''
}

if (input.prompt_cache?.hit_ratio !== undefined) {
  segments.push(
    paint('cache ', 'dim') +
      paint(`${Math.round(input.prompt_cache.hit_ratio * 100)}%`, 'cyan', true) +
      paint(
        ` ${compact(usage.cache_read_input_tokens ?? 0)} of ${compact(context.total_input_tokens ?? 0)}`,
        'dim',
      ) +
      coldWarning(input.prompt_cache),
  )
}

segments.push(git(cwd))

// How much of each subscription window is used, counting up: 100% is nothing
// left to use. A second row, between the status row and the mode line.
//
// Claude Code reports the windows only once a session has had a response, so
// the last reading is kept in the temp folder and shown until then. A window
// whose reset time has passed since that reading counts as unused again.
const limitsFile = join(tmpdir(), 'claude-statusline-limits.json')
let limits = input.rate_limits

if (limits === undefined) {
  try {
    limits = JSON.parse(readFileSync(limitsFile, 'utf8'))
  } catch {
    limits = {}
  }
} else {
  writeFileSync(limitsFile, JSON.stringify(limits))
}

const used = window =>
  window === undefined || window.resets_at * 1000 > Date.now()
    ? window?.used_percentage
    : 0

const windows = [
  ['5h', limits.five_hour],
  ['week', limits.seven_day],
].filter(([, window]) => used(window) !== undefined)

const usageRow = windows.map(([label, window]) => {
  const spent = Math.round(used(window))
  const tone = spent >= 90 ? 'red' : spent >= 70 ? 'yellow' : 'green'

  return paint(`${label} `, 'dim') + paint(`${spent}%`, tone, true)
})

// One last segment says when each window refills: "reset in 1h32m(5h)
// 3days(week)". A window that has already refilled is left out of it.
const countdowns = windows
  .map(([label, window]) => [label, minutesUntil(window.resets_at)])
  .filter(([, minutes]) => minutes > 0)
  .map(([label, minutes]) => paint(span(minutes), 'text') + paint(`(${label})`, 'dim'))

if (countdowns.length > 0) {
  usageRow.push(paint('reset in ', 'dim') + countdowns.join(' '))
}

const gap = paint('  │  ', 'dim')
const rows = [segments.join(gap)]

if (usageRow.length > 0) {
  rows.push(usageRow.join(gap))
}

process.stdout.write(rows.join('\n'))
