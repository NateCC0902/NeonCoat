// Usage: node render.mjs < diagram.mmd
// Writes <tmp>/claude-reply-media/<sha1>.png and prints {"file","width","height"},
// the size in CSS px. Needs `rsvg-convert` (brew install librsvg) on PATH.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { renderMermaidSVG } from 'beautiful-mermaid'

// Charmtone, the same colors as ~/.claude/themes/charm.json.
export const THEME = {
  bg: '#201f26',
  fg: '#ecebf0',
  line: '#858392',
  accent: '#8b75ff',
  muted: '#858392',
  font: 'Helvetica Neue',
  transparent: true,
}
// PNG px per CSS px, so the picture stays sharp when the terminal scales it.
export const ZOOM = 3

// ponytail: librsvg has no CSS var() or color-mix(), so resolve the forms
// beautiful-mermaid 1.1.3 emits (hex colors, srgb mixes). Rasterize with
// headless Chrome instead if a newer version emits more.
export function flatten(svg) {
  const vars = {}
  for (const [, name, value] of svg.matchAll(/(--[\w-]+)\s*:\s*([^;"]+)/g)) {
    vars[name] ??= value.trim() // the inline style comes first and wins
  }

  const args = list => {
    const parts = []
    let depth = 0
    let from = 0
    for (let i = 0; i < list.length; i++) {
      if (list[i] === '(') depth++
      else if (list[i] === ')') depth--
      else if (list[i] === ',' && depth === 0) {
        parts.push(list.slice(from, i))
        from = i + 1
      }
    }
    return [...parts, list.slice(from)].map(part => part.trim())
  }
  const rgb = hex =>
    hex.length === 4
      ? [...hex.slice(1)].map(digit => parseInt(digit + digit, 16))
      : [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
  const resolve = expr => {
    const call = /^(var|color-mix)\((.*)\)$/s.exec(expr.trim())
    if (!call) return expr.trim()

    const list = args(call[2])
    if (call[1] === 'var') {
      return list[0] in vars ? resolve(vars[list[0]]) : resolve(list.slice(1).join(','))
    }

    // color-mix(in srgb, <color> [p%], <color> [p%])
    const [a, b] = list.slice(1).map(part => /^(.*?)(?:\s+([\d.]+)%)?$/s.exec(part))
    const share = a[2] ? a[2] / 100 : b[2] ? 1 - b[2] / 100 : 0.5
    const [x, y] = [rgb(resolve(a[1])), rgb(resolve(b[1]))]
    const mixed = x.map((v, i) => Math.round(v * share + y[i] * (1 - share)))
    return '#' + mixed.map(v => v.toString(16).padStart(2, '0')).join('')
  }

  let out = ''
  let from = 0
  for (const { index } of svg.matchAll(/\b(?:var|color-mix)\(/g)) {
    if (index < from) continue // nested in the call just resolved

    let end = svg.indexOf('(', index) + 1
    for (let depth = 1; depth > 0 && end < svg.length; end++) {
      depth += svg[end] === '(' ? 1 : svg[end] === ')' ? -1 : 0
    }
    out += svg.slice(from, index) + resolve(svg.slice(index, end))
    from = end
  }

  // No network fonts: librsvg would not fetch them, and the leftover breaks its parser.
  return (out + svg.slice(from)).replace(/@import url\('[^']*'\);/g, '')
}

/** Draws `svg` as <tmp>/claude-reply-media/<sha1 of key>.png and prints its line. */
export function rasterize(svg, key) {
  const dir = join(tmpdir(), 'claude-reply-media')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, createHash('sha1').update(key).digest('hex') + '.png')
  const png = spawnSync('rsvg-convert', ['--zoom', String(ZOOM), '--output', file], { input: svg })
  if (png.status !== 0) throw new Error(String(png.stderr || png.error))

  const ihdr = readFileSync(file).subarray(16, 24)
  const [width, height] = [ihdr.readUInt32BE(0) / ZOOM, ihdr.readUInt32BE(4) / ZOOM]
  console.log(JSON.stringify({ file, width, height }))
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = readFileSync(0, 'utf8')
  // Named by theme and source, so a restyle never shows a picture drawn before it.
  rasterize(flatten(renderMermaidSVG(source, THEME)), JSON.stringify(THEME) + source)
}
