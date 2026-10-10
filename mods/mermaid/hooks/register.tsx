import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { Diagram } from '../types'

const diagrams = atom({ plugin: 'mermaid', key: 'diagrams' } as const, {})

// One capture group, so String.split alternates text, source, text, ...
const FENCE = /^```mermaid[^\n]*\n([\s\S]*?)\n```[ \t]*$/gm

// ponytail: a cell is taken as 2.17x as tall as wide (measured: Ghostty,
// JetBrains Mono 18) and a column as 8 px of diagram; tune these if pictures
// look squashed or the wrong size.
const CELL_ASPECT = 2.17
const PX_PER_COLUMN = 8
// ponytail: a resumed session gets its pictures back for its last few replies
// only, since each fence is a `node` run the first prompt waits for; raise
// this to reach further back.
const RESUMED_REPLIES = 3

/** Renders each fence of `text` that has no outcome yet, and records it. */
async function render($: EngineInterface, text: string) {
  const known = await read($, diagrams)

  for (const [, source = ''] of text.matchAll(FENCE)) {
    if (source in known) {
      continue
    }

    const run = await $.process
      .run(['node', `${$.plugin.root}/render/render.mjs`], {
        stdin: source,
        timeoutMs: 5_000,
      })
      .catch(() => undefined)
    const diagram: Diagram | null =
      run?.exitCode === 0 ? JSON.parse(run.stdout) : null
    await update($, diagrams, all => ({ ...all, [source]: diagram }))
  }
}

export const register: Register = on => {
  on('session.append', { door: 'response' }, async ($, e, next) => {
    for (const block of e.message.content) {
      if (typeof block.text === 'string') {
        await render($, block.text)
      }
    }

    return next(e)
  })

  // The replies a resumed session opens with were appended by an earlier
  // process, so their fences are rendered here. A new session has none.
  on('session.start', async ($, e, next) => {
    const replies = (await $.session.messages())
      .filter(message => message.role === 'assistant' && message.text !== '')
      .slice(-RESUMED_REPLIES)

    for (const reply of replies) {
      await render($, reply.text)
    }

    return next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || !e.props.text.includes('```mermaid')) {
      return next(e)
    }

    const known = await read($, diagrams)
    const pieces: (string | { source: string; diagram: Diagram })[] = []
    let text = ''
    e.props.text.split(FENCE).forEach((part, index) => {
      const isSource = index % 2 === 1
      const diagram = isSource ? known[part] : undefined

      if (diagram) {
        pieces.push(text, { source: part, diagram })
        text = ''
      } else {
        // A fence with no picture (not rendered yet, or it failed) stays code.
        text += isSource ? '```mermaid\n' + part + '\n```' : part
      }
    })

    if (pieces.length === 0) {
      return next(e)
    }

    const { Box, Image } = $.ui.resolve(e)
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
      const columns = Math.min(room, 255, Math.ceil(width / PX_PER_COLUMN))
      const rows = Math.round((columns * height) / width / CELL_ASPECT)
      children.push(
        <Box paddingLeft={indent} marginTop={1}>
          <Image
            source={{ file, format: 'png' }}
            columns={columns}
            rows={Math.min(255, Math.max(1, rows))}
            alt={piece.source}
          />
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
}
