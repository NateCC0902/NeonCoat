import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { ZOOM } from './render.mjs'

const math = source =>
  spawnSync('node', [join(import.meta.dirname, 'math.mjs')], { input: source, encoding: 'utf8' })

for (const source of ['\\frac{a}{b}', '\\sum_{i=0}^n x_i', '\\int_0^1 f(x)\\,dx']) {
  test(`math draws ${source} a few rows of text tall`, () => {
    const { file, width, height } = JSON.parse(math(source).stdout)
    const png = readFileSync(file)

    assert.equal(png.toString('latin1', 1, 4), 'PNG')
    assert.equal(png.readUInt32BE(16), Math.round(width * ZOOM))
    assert.equal(png.readUInt32BE(20), Math.round(height * ZOOM))
    assert.ok(width > 10 && width < 100 && height > 20 && height < 60, `${width} x ${height}`)
  })
}

test('math fails on what it cannot draw, with nothing on stdout', () => {
  const failures = [
    ['\\foo{x}', /Undefined control sequence/],
    ['\\frac{a}{', /Missing close brace/],
    ['x \\tag{1}', /tag/],
  ]

  for (const [source, message] of failures) {
    const run = math(source)

    assert.notEqual(run.status, 0, source)
    assert.equal(run.stdout, '', source)
    assert.match(run.stderr, message)
  }
})
