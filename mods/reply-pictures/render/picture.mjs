// Usage: node picture.mjs < path.txt
// Prints {"file","width","height"}, the size in PNG px, for the image file at
// a path: absolute, under ~/ or relative to the working directory. A PNG is
// used as it is; any other is drawn as <tmp>/claude-reply-pictures/<sha1>.png, by
// `sips` (macOS) or, for an SVG, `rsvg-convert` (brew install librsvg).
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** The start of a PNG: its signature, then the chunk that holds its size. */
function header(file) {
  const bytes = Buffer.alloc(24)
  const fd = openSync(file)
  readSync(fd, bytes)
  closeSync(fd)
  return bytes
}

// A URL resolves to a path that does not exist, and fails as one.
const path = resolve(readFileSync(0, 'utf8').trim().replace(/^~(?=\/)/, homedir()))
const stat = statSync(path)
if (!stat.isFile()) throw new Error(`not a regular file: ${path}`)

let file = path
// Told by its signature, not its extension: the terminal reads `file` as a
// PNG whatever it is called.
if (header(path).toString('latin1', 0, 8) !== '\x89PNG\r\n\x1a\n') {
  const dir = join(tmpdir(), 'claude-reply-pictures')
  mkdirSync(dir, { recursive: true })
  // Named by path and mtime, so an edited file is drawn again.
  file = join(dir, createHash('sha1').update(path + stat.mtimeMs).digest('hex') + '.png')
  const png = /\.svgz?$/i.test(path)
    ? spawnSync('rsvg-convert', ['--output', file, path])
    : spawnSync('sips', ['-s', 'format', 'png', path, '--out', file])
  if (png.status !== 0) throw new Error(String(png.stderr || png.error))
}

const ihdr = header(file)
console.log(JSON.stringify({ file, width: ihdr.readUInt32BE(16), height: ihdr.readUInt32BE(20) }))
