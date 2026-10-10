import assert from 'node:assert/strict'
import { test } from 'node:test'

import { flatten } from './render.mjs'

test('flatten resolves var() and color-mix() to hex and drops font imports', () => {
  const svg = `<svg style="--bg:#000000;--fg:#ffffff"><style>
  @import url('https://fonts.example/css2?family=Inter:wght@400;500&amp;display=swap');
  svg { --_line: var(--line, color-mix(in srgb, var(--fg) 50%, var(--bg))); }
</style><path stroke="var(--_line)" fill="color-mix(in srgb, #000 75%, #fff 25%)"/></svg>`
  const flat = flatten(svg)

  assert.match(flat, /stroke="#808080"/)
  assert.match(flat, /fill="#404040"/)
  assert.doesNotMatch(flat, /var\(|color-mix\(|@import/)
})
