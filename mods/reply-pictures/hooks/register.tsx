import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { Diagram } from '../types'

const diagrams = atom({ plugin: 'reply-pictures', key: 'diagrams' } as const, {})
const zoomed = atom({ plugin: 'reply-pictures', key: 'zoomed' } as const, null)
const PANE = 'picture-zoom'

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
 * undefined for a block the mod leaves as text.
 */
function classify(block: string) {
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

  // An image on the network is not fetched: only a file on this machine.
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(path) ? undefined : { script: 'picture', source: path }
}

/** Renders each block of `text` that has no outcome yet, and records it. */
async function render($: EngineInterface, text: string) {
  const known = await read($, diagrams)
  const cwd = await $.session.cwd()

  for (const [block] of text.matchAll(BLOCK)) {
    const job = classify(block)
    // An image is read again each time it is shown: the file behind an
    // unchanged path may be a new picture.
    if (job === undefined || (job.script !== 'picture' && block in known)) {
      continue
    }

    const run = await $.process
      .run(['node', `${$.plugin.root}/render/${job.script}.mjs`], {
        stdin: job.source,
        timeoutMs: 5_000,
        cwd,
      })
      .catch(() => undefined)
    const diagram: Diagram | null =
      run?.exitCode === 0 ? JSON.parse(run.stdout) : null
    await update($, diagrams, all => ({ ...all, [block]: diagram }))
  }
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

  on('session.append', { door: 'response' }, async ($, e, next) => {
    for (const block of e.message.content) {
      if (typeof block.text === 'string') {
        await render($, block.text)
      }
    }

    return next(e)
  })

  // The replies a resumed session opens with were appended by an earlier
  // process, so their blocks are rendered here. A new session has none.
  on('session.start', async ($, e, next) => {
    const replies = (await $.session.messages()).filter(
      message => message.role === 'assistant' && message.text !== '',
    )

    // `slice(-0)` would keep every reply.
    for (const reply of resumedReplies > 0 ? replies.slice(-resumedReplies) : []) {
      await render($, reply.text)
    }

    return next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.text.search(BLOCK) === -1) {
      return next(e)
    }

    const known = await read($, diagrams)
    const pieces: (string | { block: string; alt: string; isFile: boolean; diagram: Diagram })[] = []
    let text = ''
    e.props.text.split(BLOCK).forEach((part, index) => {
      const diagram = index % 2 === 1 ? known[part] : undefined

      if (diagram) {
        const job = classify(part)
        pieces.push(text, {
          block: part,
          alt: job?.source ?? part,
          isFile: job?.script === 'picture',
          diagram,
        })
        text = ''
      } else {
        // A block with no picture (one the mod does not draw, one not
        // rendered yet, one that failed) stays as it was written.
        text += part
      }
    })

    if (pieces.length === 0) {
      return next(e)
    }

    const { Box, Button, Image } = $.ui.resolve(e)
    const room = Math.max(1, (e.viewport?.columns ?? 80) - 4)
    // The engine indents nothing but the block its bullet opens, so what
    // follows that block lines up under its text here.
    const indent = e.props.isFirstOfReply ? 2 : 0
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

      const { file, width, height } = piece.diagram
      const widest = Math.min(room, 255)
      const natural = Math.min(widest, Math.ceil(width / pxPerColumn))
      // Whole rows first, then the columns that keep the picture's shape: a
      // formula one row tall is drawn a little larger, not stretched.
      const rows = Math.min(255, Math.max(1, Math.round((natural * height) / width / cellAspect)))
      const columns = Math.min(widest, Math.max(1, Math.round((rows * cellAspect * width) / height)))
      const { block, alt } = piece
      const key = hash(block)
      children.push(
        <Box flexDirection="column" paddingLeft={indent} marginTop={1}>
          <Image
            source={{ file, format: 'png' }}
            columns={columns}
            rows={rows}
            alt={alt}
          />
          <Box flexDirection="row" gap={2}>
            <Button
              key={`copy:${key}`}
              label={piece.isFile ? 'copy path' : 'copy source'}
              plain
              dimColor
              onPress={async press => {
                const copied = await $.ui.copy({ text: alt, surface: press.surface })
                $.ui.toast(copied.isCopied ? 'Copied' : `Not copied: ${copied.reason}`)
              }}
            />
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
          </Box>
        </Box>,
      )
    }

    return (
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
    if (e.surface !== 'terminal' || block === null || !diagram) {
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
          alt={classify(block)?.source ?? block}
        />
      </Box>
    )
  })
}
