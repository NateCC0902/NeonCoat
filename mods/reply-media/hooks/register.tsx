import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, Timer } from 'claude-code'

import type { Diagram, Failure, Frames } from '../types'

const diagrams = atom({ plugin: 'reply-media', key: 'diagrams' } as const, {})
const zoomed = atom({ plugin: 'reply-media', key: 'zoomed' } as const, null)
const playing = atom({ plugin: 'reply-media', key: 'playing' } as const, null)
const PANE = 'picture-zoom'
// What `![alt](path)` plays rather than shows, told by the path's extension.
const VIDEO = /\.(mp4|m4v|mov|webm|mkv|gif)$/i
// The kinds of block the mod draws: the `/config` switch of each, and the
// renderer script that draws it.
const KINDS = [
  ['diagrams', 'render'],
  ['math', 'math'],
  ['images', 'picture'],
  ['videos', 'video'],
] as const
type Script = (typeof KINDS)[number][1]

// What Claude reads in its system prompt, so that it writes the blocks the mod
// draws: Claude writes none of them unprompted. A kind switched off is not
// told, so Claude does not write a block that would stay its source.
function forms(drawn: ReadonlySet<Script>) {
  const isImage = drawn.has('picture')
  const isVideo = drawn.has('video')
  const notes = [
    drawn.has('render') && [
      'Diagrams:',
      '',
      'Draw diagrams in replies as ```mermaid code fences, never as ASCII art. The reply-media mod turns each fence into a picture in the terminal.',
      'Use only these types, the rest do not render: flowchart, stateDiagram-v2, sequenceDiagram, classDiagram, erDiagram, xychart-beta.',
      'Start the fence at column 0: an indented fence (inside a list item or a quote) is not picked up.',
      "Prefer flowchart LR: a TD chart with more than a few nodes fills the terminal's height.",
      'Directory trees and tables are not diagrams: keep them as text.',
    ],
    drawn.has('math') && [
      'Math:',
      '',
      'Write a formula that stands on a line of its own as LaTeX in a ```math code fence, one formula per fence, starting at column 0. The reply-media mod turns it into a picture. Leave out `\\tag`: a tagged formula is not drawn.',
      'Write math inside a sentence in Unicode (a⃗ · b⃗ = |a||b|cos θ), never as `$x$`: a picture cannot sit inside a line of text.',
    ],
    (isImage || isVideo) && [
      'Images:',
      '',
      isImage
        ? "To show an image file from this machine, write `![alt](path)` on a line of its own, starting at column 0. The reply-media mod draws it. The path is absolute, under `~/`, or relative to the session's working directory. An image at a URL is not fetched, so give its link as text."
        : "To show a video file from this machine (mp4, mov, webm, mkv, gif), write `![alt](path)` on a line of its own, starting at column 0. The reply-media mod shows its first frame with a play button. The path is absolute, under `~/`, or relative to the session's working directory.",
      ...(isImage && isVideo ? ['A video file (mp4, mov, webm, mkv, gif) written the same way is shown as its first frame with a play button.'] : []),
      ...(isImage ? ['For a drawing mermaid cannot make (a UI sketch, a layout, an annotated picture), write an SVG file to the scratchpad and show it with the image form above.'] : []),
    ],
  ].filter(note => note !== false)

  return notes.length === 0 ? undefined : notes.map(note => note.join('\n')).join('\n\n')
}

// A Button's key, from what it copies: a reply is drawn in parts when two mods
// draw it between them, so a count kept by one part would repeat in the next.
const hash = (text: string) =>
  ([...text].reduce((sum, char) => (Math.imul(sum, 31) + char.charCodeAt(0)) | 0, 0) >>> 0).toString(36)

// What a reply holds on lines of its own that may become a picture: a code
// fence, a `$$` formula, an image. Every fence is matched, drawn or not, so
// that an example of a formula or an image inside one is left alone. One
// capture group, so String.split alternates text, block, text, ...
// ponytail: fences of exactly three backticks; a longer fence that holds a
// shorter one is cut at the inner close and stays text. Count the ticks if
// nested fences start to matter.
const BLOCK =
  /^(```[^\n]*\n[\s\S]*?\n```[ \t]*|\$\$[ \t]*\n[\s\S]*?\n\$\$[ \t]*|!\[[^\]\n]*\]\([^)\n]+\)[ \t]*)$/gm

/**
 * The renderer script that draws a block and what that script reads, or
 * undefined for a block the mod leaves as text, its kind switched off too.
 */
function classify(block: string, drawn: ReadonlySet<Script>) {
  const job = kindOf(block)

  return job !== undefined && drawn.has(job.script) ? job : undefined
}

function kindOf(block: string): { script: Script; source: string } | undefined {
  const fence = /^```([^\n]*)\n([\s\S]*)\n```[ \t]*$/.exec(block)
  if (fence) {
    const [, info = '', source = ''] = fence
    // The whole name: a `mathematica` fence is code, not a formula.
    const [language] = info.trim().split(/\s+/)
    const script = language === 'mermaid' ? 'render' : language === 'math' ? 'math' : undefined

    return script === undefined ? undefined : { script, source }
  }

  const formula = /^\$\$[ \t]*\n([\s\S]*)\n\$\$[ \t]*$/.exec(block)
  if (formula) {
    return { script: 'math', source: formula[1] ?? '' }
  }

  const path = /\]\(([^)\n]+)\)/.exec(block)?.[1]?.trim() ?? ''

  // A file on the network is not fetched: only one on this machine.
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(path)
    ? undefined
    : { script: VIDEO.test(path) ? 'video' : 'picture', source: path }
}

/**
 * Runs a renderer script, named with its arguments, and answers what it
 * printed, or why it failed: the script's `Error:` line, or the last line it
 * wrote.
 */
async function run<T>(
  $: EngineInterface,
  [script, ...args]: string[],
  init: { stdin: string; timeoutMs: number; cwd?: string },
): Promise<T | Failure> {
  const ran = await $.process
    .run(['node', `${$.plugin.root}/render/${script}.mjs`, ...args], init)
    .catch((error: unknown) => ({ exitCode: 1, stdout: '', stderr: String(error) }))
  if (ran.exitCode === 0) {
    return JSON.parse(ran.stdout) as T
  }

  // More than one `Error:` when the tool a script ran opens its own message
  // with it, as `sips` does.
  const line = /^(?:\w*Error: )+(.+)$/m.exec(ran.stderr)?.[1]

  return { error: line ?? ran.stderr.trim().split('\n').at(-1) ?? '' }
}

/** Whether the disk says a picture's file is not there; no answer at all is not that. */
function isGone($: EngineInterface, file: string) {
  return $.fs.stat(file).then(
    () => false,
    (error: unknown) => /ENOENT/.test(String(error)),
  )
}

/**
 * Renders each block of `text` that has no outcome yet, and records it;
 * `isForced` renders the ones that have an outcome too.
 */
async function render($: EngineInterface, text: string, drawn: ReadonlySet<Script>, isForced = false) {
  const known = await read($, diagrams)
  const cwd = await $.session.cwd()

  for (const [block] of text.matchAll(BLOCK)) {
    const job = classify(block, drawn)
    // An image or a video is read again each time it is shown: the file
    // behind an unchanged path may be a new one.
    const isFile = job?.script === 'picture' || job?.script === 'video'
    if (job === undefined || (!isFile && !isForced && known[block])) {
      continue
    }

    const outcome = await run<Diagram>($, [job.script], {
      stdin: job.source,
      timeoutMs: 5_000,
      cwd,
    })
    await update($, diagrams, all => ({ ...all, [block]: outcome }))
  }
}

// Blocks whose swept picture was drawn again since this load: once each, so
// that a file which cannot be made again is not tried at every draw.
const redrawn = new Set<string>()
// One video plays at a time. Where each one stopped is kept by its block; the
// drawing reads it when the `playing` value changes.
// shortcut: kept in the module, so a reload of the mod rewinds every video;
// keep it in `$.state` if that starts to matter.
let timer: Timer | undefined
const stoppedAt = new Map<string, number>()

const frameFile = (frames: Frames, index: number) =>
  `${frames.dir}/f${String(index + 1).padStart(5, '0')}.png`

/** Stops the video that is playing, if one is. */
async function stop($: EngineInterface) {
  timer?.cancel()
  timer = undefined
  await update($, playing, () => null)
}

/**
 * Plays the video of `block` in the Image `key` of the row `site`, from where
 * it stopped, or stops it when it is the one playing.
 */
async function toggle($: EngineInterface, site: string, key: string, block: string) {
  const wasPlaying = (await read($, playing)) === block
  await stop($)
  const diagram = (await read($, diagrams))[block]
  if (wasPlaying || !diagram || 'error' in diagram || !diagram.clip) {
    return
  }

  // Cut at the first play, not when the reply arrives: it takes seconds and
  // disk, and most clips shown are never played.
  if (diagram.frames === undefined) {
    $.ui.toast('Cutting the video into frames…')
  }
  const frames =
    diagram.frames ??
    (await run<Frames>($, ['video', 'frames'], { stdin: diagram.clip, timeoutMs: 120_000 }))
  if ('error' in frames) {
    $.ui.toast(`Not played: ${frames.error}`)

    return
  }
  if (frames !== diagram.frames) {
    await update($, diagrams, all => ({ ...all, [block]: { ...diagram, frames } }))
  }

  // From the start again once it has reached its end.
  const from = stoppedAt.get(block) ?? 0
  let index = from >= frames.count - 1 ? 0 : from
  await update($, playing, () => block)
  // A second press while the cut ran started a timer of its own.
  timer?.cancel()
  const own: Timer = $.clock.every(Math.round(1000 / frames.fps), async () => {
    const shown = index++
    const isLast = shown >= frames.count - 1
    if (isLast) {
      own.cancel()
    }
    stoppedAt.set(block, shown)
    const blit = await $.ui
      .blit({ requestId: site, key, source: { file: frameFile(frames, shown), format: 'png' } })
      .catch(() => ({ deny: 'failed' }))
    // Denied when no Image is mounted to swap: the row scrolled away.
    if (timer === own && (isLast || blit.deny !== undefined)) {
      await stop($)
    }
  })
  timer = own
}

export const register: Register = (on, options) => {
  if (options.enabled === false) {
    return
  }

  // ponytail: a cell's height over its width and the picture pixels a column
  // shows are the person's to tune (`/config`): they depend on the terminal
  // and its font, which the mod cannot measure.
  const cellAspect = Number(options.cellAspect)
  const pxPerColumn = Number(options.pxPerColumn)
  const resumedReplies = Number(options.resumedReplies)
  const drawn = new Set(KINDS.filter(([option]) => options[option] !== false).map(([, script]) => script))
  const told = forms(drawn)
  // Under a picture: copy its source, and zoom it (a video: open it in the player).
  const hasButtons = options.buttons !== false

  // Told only where a terminal draws the reply: under `-p`, the SDK or an app
  // the forms would come out as their source.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const isDrawn = e.surfaces.includes('terminal')

    return isDrawn && told !== undefined
      ? { sections: [...composed.sections, { id: 'reply-media:forms', text: told, scope: 'session' }] }
      : composed
  })

  on('session.append', { door: 'response' }, async ($, e, next) => {
    // A picture no terminal draws is not worth its render.
    if (!(await $.session.surfaces()).includes('terminal')) {
      return next(e)
    }

    for (const block of e.message.content) {
      if (typeof block.text === 'string') {
        await render($, block.text, drawn)
      }
    }

    return next(e)
  })

  // The replies a resumed session opens with were appended by an earlier
  // process, so their blocks are rendered here. A new session has none.
  on('session.start', async ($, e, next) => {
    // A reload starts the module over with no timer, but the value is kept.
    await stop($)
    const replies = (await $.session.messages()).filter(
      message => message.role === 'assistant' && message.text !== '',
    )

    // `slice(-0)` would keep every reply. A session no terminal draws gets none.
    const count = e.surface === 'terminal' ? resumedReplies : 0
    for (const reply of count > 0 ? replies.slice(-count) : []) {
      await render($, reply.text, drawn)
    }

    return next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.text.search(BLOCK) === -1) {
      return next(e)
    }

    const known = await read($, diagrams)
    const pieces: (
      | string
      | { block: string; alt: string; isFile: boolean; diagram: Diagram }
      | { alt: string; error: string }
    )[] = []
    let text = ''
    for (const [index, part] of e.props.text.split(BLOCK).entries()) {
      // A kind switched off keeps its block as text, drawn before or not.
      let outcome = index % 2 === 1 && classify(part, drawn) !== undefined ? known[part] : undefined
      // The temp folder is swept after some days. The block is text again
      // while its picture is drawn again from it.
      if (outcome && !('error' in outcome) && (await isGone($, outcome.file))) {
        outcome = undefined
        if (!redrawn.has(part)) {
          redrawn.add(part)
          void render($, part, drawn, true)
        }
      }

      if (outcome) {
        const job = classify(part, drawn)
        const alt = job?.source ?? part
        const isFile = job?.script === 'picture' || job?.script === 'video'
        pieces.push(
          text,
          'error' in outcome
            ? { alt, error: outcome.error }
            : { block: part, alt, isFile, diagram: outcome },
        )
        text = ''
      } else {
        // A block with no outcome (one the mod does not draw, one not
        // rendered yet) stays as it was written.
        text += part
      }
    }

    if (pieces.length === 0) {
      return next(e)
    }

    const { Box, Button, Image, Text } = $.ui.resolve(e)
    const room = Math.max(1, (e.viewport?.columns ?? 80) - 4)
    // The engine draws the reply's bullet with the text that opens it; a
    // reply that opens with a picture gets its bullet here, beside it.
    const [opening = ''] = pieces
    const hasOwnBullet = e.props.isFirstOfReply && typeof opening === 'string' && opening.trim() === ''
    // The engine indents nothing but the block its bullet opens, so what
    // follows that block lines up under its text here.
    const indent = e.props.isFirstOfReply && !hasOwnBullet ? 2 : 0
    const children: RenderElement[] = []

    for (const piece of [...pieces, text]) {
      if (typeof piece === 'string') {
        if (piece.trim() !== '') {
          // The engine draws the text around a picture, bullet and all.
          const isFirst = children.length === 0
          const drawn = await next({
            ...e,
            props: {
              ...e.props,
              text: piece.trim(),
              isFirstOfReply: e.props.isFirstOfReply && isFirst,
            },
          })
          children.push(isFirst ? drawn : <Box paddingLeft={indent}>{drawn}</Box>)
        }

        continue
      }

      if ('error' in piece) {
        // Boxed in the error color, so that a block which failed is not taken
        // for plain text: the reason, then what the script was given.
        children.push(
          <Box flexDirection="column" paddingLeft={indent} marginTop={1}>
            <Box
              flexDirection="column"
              alignSelf="flex-start"
              paddingX={1}
              borderStyle="round"
              borderColor="error"
            >
              <Text bold color="error">{`✗ not drawn: ${piece.error}`}</Text>
              <Text dimColor>{piece.alt}</Text>
            </Box>
          </Box>,
        )

        continue
      }

      const { file, width, height, path, clip, frames } = piece.diagram
      const widest = Math.min(room, 255)
      const natural = Math.min(widest, Math.ceil(width / pxPerColumn))
      // Whole rows first, then the columns that keep the picture's shape: a
      // formula one row tall is drawn a little larger, not stretched.
      const rows = Math.min(255, Math.max(1, Math.round((natural * height) / width / cellAspect)))
      const columns = Math.min(widest, Math.max(1, Math.round((rows * cellAspect * width) / height)))
      const { block, alt } = piece
      const key = hash(block)
      const site = e.requestId
      const isPlaying = clip !== undefined && (await read($, playing)) === block
      children.push(
        <Box flexDirection="column" paddingLeft={indent} marginTop={1}>
          <Image
            // Keyed for a video alone: its frames are swapped in under that key.
            key={clip === undefined ? undefined : `view:${key}`}
            // It shows the frame it stopped at, so a redraw does not rewind
            // it; before its first play, its first frame.
            source={{
              file: frames === undefined ? file : frameFile(frames, stoppedAt.get(block) ?? 0),
              format: 'png',
            }}
            columns={columns}
            rows={rows}
            alt={alt}
          />
          <Box flexDirection="row" gap={2}>
            {clip !== undefined && (
              <Button
                key={`play:${key}`}
                label={isPlaying ? '❚❚ pause' : '▶ play'}
                plain
                onPress={() => toggle($, site, `view:${key}`, block)}
              />
            )}
            {hasButtons && (
            <Button
              key={`copy:${key}`}
              label={piece.isFile ? 'copy path' : 'copy source'}
              plain
              dimColor
              onPress={async press => {
                // A file by the absolute path its script opened, not as written.
                const text = piece.isFile ? (path ?? clip ?? alt) : alt
                const copied = await $.ui.copy({ text, surface: press.surface })
                $.ui.toast(copied.isCopied ? 'Copied' : `Not copied: ${copied.reason}`)
              }}
            />
            )}
            {!hasButtons ? undefined : clip === undefined ? (
              <Button
                key={`zoom:${key}`}
                label="zoom"
                plain
                dimColor
                onPress={async () => {
                  await update($, zoomed, () => block)
                  // Asked for by this press, so it is placed at any width: docked
                  // beside the transcript from 110 columns, above the prompt below.
                  await $.ui.open({
                    id: PANE,
                    title: 'Picture',
                    closeOnEscape: true,
                    columns: Math.round((e.viewport?.columns ?? 80) * 0.6),
                    rows: Math.round((e.viewport?.rows ?? 24) * 0.6),
                  })
                }}
              />
            ) : (
              // The frames are small, slow and silent: the clip itself opens
              // in the player the person has for it.
              <Button
                key={`open:${key}`}
                label="open"
                plain
                dimColor
                onPress={async () => {
                  await $.process.run(['open', clip])
                }}
              />
            )}
          </Box>
        </Box>,
      )
    }

    return hasOwnBullet ? (
      // Level with the picture, which brings a blank row above itself.
      <Box flexDirection="row">
        <Box marginTop={1}>
          <Text color="text">⏺ </Text>
        </Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {children}
        </Box>
      </Box>
    ) : (
      // No gap: the engine's text brings a blank row above itself.
      <Box flexDirection="column">
        {children}
      </Box>
    )
  })

  // The zoomed picture, as large as the pane's body holds with its shape kept.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    const block = await read($, zoomed)
    const diagram = block === null ? undefined : (await read($, diagrams))[block]
    if (
      e.surface !== 'terminal' ||
      block === null ||
      !diagram ||
      'error' in diagram ||
      (await isGone($, diagram.file))
    ) {
      return <Text dimColor>No picture to show.</Text>
    }

    const { Box, Image } = $.ui.resolve(e)

    const wide = Math.min(255, Math.max(1, e.props.bodyColumns))
    const tall = Math.min(255, Math.max(1, e.props.scroll.bodyRows))
    const rows = Math.round((wide * diagram.height) / diagram.width / cellAspect)
    const isTooTall = rows > tall
    const columns = isTooTall
      ? Math.round((tall * cellAspect * diagram.width) / diagram.height)
      : wide

    return (
      <Box>
        <Image
          source={{ file: diagram.file, format: 'png' }}
          columns={Math.max(1, columns)}
          rows={Math.max(1, isTooTall ? tall : rows)}
          alt={classify(block, drawn)?.source ?? block}
        />
      </Box>
    )
  })
}
