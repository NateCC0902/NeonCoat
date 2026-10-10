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
  // Last in the first row; after it the name the person gave, never a
  // derived one or a title.
  assert.match(draw('on'), /│ {2}◉ rc - worker$/m)
  assert.match(draw('off'), /│ {2}○ rc$/m)
  assert.doesNotMatch(draw('not-running'), /[◉○] rc/)
})

test('names the other sessions that are running, the one waiting on the person first', () => {
  // The second row holds nothing else here: no usage window is known.
  assert.match(draw('on'), /^garage ◆ input needed {2}empty-ws-89 ○$/m)
  assert.match(draw('off'), /^garage ◆ input needed {2}worker ●$/m)
  assert.doesNotMatch(draw('on'), /ghost/)
})
