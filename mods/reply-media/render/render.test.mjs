import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

import { flatten, withModelOrder } from './render.mjs'

test('a loop is drawn in the order its nodes are written', async () => {
  registerHooks({ load: withModelOrder })
  const { renderMermaidSVG } = await import('beautiful-mermaid')
  // A retry loop, which ELK's default cycle breaker draws as start → ok? → try,
  // and a workflow that returns to its start, which a greedy one starts at review.
  const graphs = [
    ['flowchart LR\n  S[start] --> A[try]\n  A --> B{ok?}\n  B -->|no| A\n  B -->|yes| C[done]', ['start', 'try', 'ok\\?', 'done']],
    ['flowchart LR\n  A[main] --> B[branch] --> C[commit] --> R{review}\n  R -->|changes| C\n  R -->|ok| M[merge] --> A', ['main', 'branch', 'commit', 'review', 'merge']],
  ]
  for (const [source, labels] of graphs) {
    const svg = renderMermaidSVG(source)
    const xs = labels.map(label => Number(new RegExp(`<text[^>]*x="([\\d.]+)"[^>]*>${label}<`).exec(svg)?.[1]))

    assert.ok(xs.every(Number.isFinite), `every label found: ${xs}`)
    assert.deepEqual(xs, [...xs].sort((a, b) => a - b), labels.join(' → '))
  }
})

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
