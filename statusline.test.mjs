// Run: node --test statusline.test.mjs
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// A home folder of the test's own, holding the registry of running sessions.
const home = mkdtempSync(join(tmpdir(), 'statusline-'))
const sessions = join(home, '.claude', 'sessions')
mkdirSync(sessions, { recursive: true })
const running = (file, fields) =>
  writeFileSync(join(sessions, `${file}.json`), JSON.stringify(fields))
// A process that is running (this one) and one that has ended.
const live = process.pid
const dead = spawnSync('true').pid

running(1, {
  pid: live,
  sessionId: 'on',
  updatedAt: 2,
  bridgeSessionId: 'session_x',
  name: 'worker',
  nameSource: 'user',
  status: 'busy',
})
running(2, {
  pid: live,
  sessionId: 'off',
  updatedAt: 2,
  name: 'empty-ws-89',
  nameSource: 'derived',
  status: 'idle',
})
// An earlier, crashed run of `off`, left behind with Remote Control on.
running(3, {
  pid: dead,
  sessionId: 'off',
  updatedAt: 1,
  bridgeSessionId: 'session_y',
  name: 'ghost',
  nameSource: 'derived',
  status: 'busy',
})
running(4, {
  pid: live,
  sessionId: 'asking',
  updatedAt: 2,
  name: 'garage',
  nameSource: 'derived',
  status: 'waiting',
  waitingFor: 'input needed',
})

/** The rows drawn for a session, their colors taken out. */
const draw = sessionId =>
  execFileSync('node', [fileURLToPath(new URL('./statusline.mjs', import.meta.url))], {
    input: JSON.stringify({ session_id: sessionId, session_name: 'A title made up' }),
    env: { ...process.env, HOME: home, TMPDIR: home },
    encoding: 'utf8',
  }).replace(/\x1b\[[\d;]*m/g, '')

test('says whether the session is under Remote Control, or nothing when it cannot tell', () => {
  // In the second row, ahead of the other sessions; after it the name the
  // person gave, never a derived one or a title.
  assert.match(draw('on'), /^◉ rc - worker {2}│ {2}\(2\)/m)
  assert.match(draw('off'), /^○ rc {2}│ {2}\(2\)/m)
  assert.doesNotMatch(draw('not-running'), /[◉○] rc/)
})

test('names the other sessions that are running, the one waiting on the person first', () => {
  // Last in the second row.
  assert.match(draw('on'), /│ {2}\(2\) {2}◆ garage - input needed {2}○ empty-ws-89$/m)
  assert.match(draw('off'), /│ {2}\(2\) {2}◆ garage - input needed {2}● worker$/m)
  assert.doesNotMatch(draw('on'), /ghost/)
})

/**
 * The rows drawn for `input`, colors kept, with a home and temp folder of
 * their own (`dir`, a new one unless given): no sessions, no saved readings.
 */
const status = (input, dir = mkdtempSync(join(tmpdir(), 'statusline-'))) =>
  execFileSync('node', [fileURLToPath(new URL('./statusline.mjs', import.meta.url))], {
    input: JSON.stringify(input),
    env: { ...process.env, HOME: dir, TMPDIR: dir },
    encoding: 'utf8',
  })
const plain = text => text.replace(/\x1b\[[\d;]*m/g, '')
// The theme's colors, as statusline.mjs paints them.
const RGB = { green: '0;255;178', yellow: '245;239;52', red: '255;87;125' }
const now = () => Math.floor(Date.now() / 1000)

test('empty input still draws one row, each field at its fallback', () => {
  const drawn = plain(status({}))

  assert.match(drawn, /^ctx ─{12} 0% {2}│ {2}\$0\.00 {2}│ {2}\? {2}│/)
  assert.doesNotMatch(drawn, /\n/)
})

test('the context bar fills with use, yellow from 70% and red from 90%', () => {
  for (const [percent, filled, tone] of [[1, 1, 'green'], [75, 9, 'yellow'], [95, 11, 'red']]) {
    const drawn = status({ context_window: { used_percentage: percent } })

    assert.match(plain(drawn), new RegExp(`^ctx ━{${filled}}─{${12 - filled}} ${percent}%`))
    assert.ok(drawn.includes(`${RGB[tone]}m ${percent}%`), `${percent}% in ${tone}`)
  }
})

test('the cost, the model and its effort', () => {
  const drawn = status({ cost: { total_cost_usd: 1.234 }, model: { display_name: 'Opus 5.5' }, effort: { level: 'high' } })

  assert.match(plain(drawn), / {2}\$1\.23 {2}│ {2}Opus 5\.5 high {2}│/)
})

test('the cache hit rate, warned of in its last minutes and once it is cold', () => {
  const cache = fields =>
    plain(
      status({
        context_window: { total_input_tokens: 130_000, current_usage: { cache_read_input_tokens: 120_000 } },
        prompt_cache: { hit_ratio: 0.93, caching_observed: true, warm: true, ttl: '1h', expires_at: now() + 3600, ...fields },
      }),
    )

  assert.match(cache({}), /cache 93% 120k of 130k {2}│/)
  // 150 s left is 3 whole minutes: within the hour cache's last 5, not the
  // 5-minute cache's last 1.
  assert.match(cache({ expires_at: now() + 150 }), /cache 93% 120k of 130k {2}⚠ cold in 3m {2}│/)
  assert.doesNotMatch(cache({ expires_at: now() + 150, ttl: '5m' }), /⚠/)
  assert.match(cache({ warm: false, recache_tokens_if_cold: 1_500_000 }), /⚠ cold · 1\.5M to rebuild/)
})

test('tokens per second are tallied over the session\'s responses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'statusline-'))
  const speed = (apiMs, input, output) =>
    plain(
      status(
        {
          session_id: 'speedy',
          cost: { total_api_duration_ms: apiMs },
          context_window: { total_input_tokens: input, total_output_tokens: output },
        },
        dir,
      ),
    )

  // The first reading starts the tally: no speed yet.
  assert.doesNotMatch(speed(1000, 10, 0), /t\/s/)
  // 200 tokens in the 2 s of API time since.
  assert.match(speed(3000, 20, 200), / {2}100 t\/s {2}│/)
  // The same response read again changes nothing.
  assert.match(speed(3000, 20, 200), / {2}100 t\/s {2}│/)
})

test('a working folder more than three deep under home is cut to its last two', () => {
  const dir = mkdtempSync(join(tmpdir(), 'statusline-'))

  assert.match(plain(status({ cwd: join(dir, 'a', 'b', 'c', 'd') }, dir)), / {2}…\/c\/d {2}│ {2}⎇ no git$/)
  assert.match(plain(status({ cwd: join(dir, 'a', 'b') }, dir)), / {2}~\/a\/b {2}│/)
})

test('the subscription windows and when each refills, kept until the next reading', () => {
  const dir = mkdtempSync(join(tmpdir(), 'statusline-'))
  const at = now()
  const drawn = status(
    {
      rate_limits: {
        five_hour: { used_percentage: 72, resets_at: at + 92 * 60 - 30 },
        seven_day: { used_percentage: 95, resets_at: at + 3 * 86_400 - 30 },
      },
    },
    dir,
  )
  const second = input => plain(status(input, dir)).split('\n')[1]

  assert.equal(plain(drawn).split('\n')[1], '5h 72%  week 95%  │  1h32m(5h) 3days(week)')
  assert.ok(drawn.includes(`${RGB.yellow}m72%`) && drawn.includes(`${RGB.red}m95%`))
  // A session with no response yet shows the last reading.
  assert.equal(second({}), '5h 72%  week 95%  │  1h32m(5h) 3days(week)')
  // A window that has refilled since its reading counts as unused, with no countdown.
  assert.equal(second({ rate_limits: { five_hour: { used_percentage: 80, resets_at: at - 60 } } }), '5h 0%')
})
