// Run: node --test statusline.test.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// A home folder of the test's own, holding the registry of running sessions.
const home = mkdtempSync(join(tmpdir(), 'statusline-'))
const sessions = join(home, '.claude', 'sessions')
mkdirSync(sessions, { recursive: true })
const running = (pid, fields) =>
  writeFileSync(join(sessions, `${pid}.json`), JSON.stringify({ pid, ...fields }))

running(1, { sessionId: 'on', updatedAt: 2, bridgeSessionId: 'session_x' })
running(2, { sessionId: 'off', updatedAt: 2 })
// An earlier, crashed run of `off`, left behind with Remote Control on.
running(3, { sessionId: 'off', updatedAt: 1, bridgeSessionId: 'session_y' })

/** The rows drawn for a session, their colors taken out. */
const draw = sessionId =>
  execFileSync('node', [fileURLToPath(new URL('./statusline.mjs', import.meta.url))], {
    input: JSON.stringify({ session_id: sessionId }),
    env: { ...process.env, HOME: home, TMPDIR: home },
    encoding: 'utf8',
  }).replace(/\x1b\[[\d;]*m/g, '')

test('says whether the session is under Remote Control, or nothing when it cannot tell', () => {
  // First of all in the first row.
  assert.match(draw('on'), /^◉ rc {2}│/)
  assert.match(draw('off'), /^○ rc off {2}│/)
  assert.doesNotMatch(draw('not-running'), /[◉○] rc/)
})
