import type { Register, RenderElement } from 'claude-code'

// Charmtone (the palette of Charm's tools), one hue per kind of thing; change
// these to restyle. `ink` is the text on the `h1` badge, as in Glow.
const COLOR = {
  h1: '#6b50ff',
  h2: '#ff60ff',
  h3: '#00a4ff',
  h4: '#ff985a',
  bullet: '#00ffb2',
  number: '#e8fe96',
  rule: '#605f6b',
  // A `rules` table's line under its header (Squid), and the faint one
  // between its rows (Iron, the theme's prompt border).
  headRule: '#858392',
  rowRule: '#4d4c57',
  quote: '#ff60ff',
  ink: '#e8fe96',
} as const
// The `/config` switch of each kind of block the mod restyles. A block whose
// switch is off goes back to the engine as the markdown it was written as.
const SWITCHES = ['headings', 'lists', 'quotes', 'callouts', 'tables', 'rules', 'codeCards'] as const
type Switch = (typeof SWITCHES)[number]

// What Claude reads in its system prompt, so that it writes the forms the mod
// draws only when Claude chooses to. A form switched off is not told.
function forms(off: ReadonlySet<Switch>) {
  const lines = [
    !off.has('callouts') &&
      'For a warning or a note the user must not miss, write a GitHub alert: a quote whose first line is `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]`. It becomes a colored box.',
    !off.has('lists') && 'For steps or checks to tick off, write a task list: `- [ ]` and `- [x]`.',
    !off.has('codeCards') &&
      'Put a command or snippet the user will copy in a code fence of its own, with its language, not in inline code: the fence gets a copy button.',
  ].filter(line => line !== false)

  return lines.length === 0
    ? undefined
    : ['Formatting:', '', 'The reply-markdown mod draws these forms in the terminal, so use them where they fit.', ...lines].join('\n')
}
// GitHub's five alerts, `> [!NOTE]` and the rest, in the palette's hues.
const CALLOUT: Record<string, { label: string; color: string }> = {
  NOTE: { label: 'Note', color: '#00a4ff' },
  TIP: { label: 'Tip', color: '#00ffb2' },
  IMPORTANT: { label: 'Important', color: '#8b75ff' },
  WARNING: { label: 'Warning', color: '#f5ef34' },
  CAUTION: { label: 'Caution', color: '#ff577d' },
}
const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/i
const TASK = /^\[([ xX])\][ \t]+([\s\S]*)$/
// ponytail: the bar beside a quote, and between a table's cells, is this
// many rows, clipped to what it stands beside; anything taller runs out of bar.
const bar = (glyph: string) => Array(200).fill(glyph).join('\n')
const BAR = bar('│')
// A table's frame by border style, under the names the engine's own Box
// takes: the corners and joints of its three edges, then its two lines.
// Thick lines have square corners only: Unicode has no heavy arc. `rules`,
// the default, has no frame: a line under the header and between the rows.
const FRAME: Record<string, { edges: [string, string, string]; line: string; bar: string }> = {
  round: { edges: ['╭┬╮', '├┼┤', '╰┴╯'], line: '─', bar: '│' },
  single: { edges: ['┌┬┐', '├┼┤', '└┴┘'], line: '─', bar: '│' },
  bold: { edges: ['┏┳┓', '┣╋┫', '┗┻┛'], line: '━', bar: '┃' },
}

type Block = { hasGapAbove: boolean } & (
  | { kind: 'raw'; text: string }
  | { kind: 'code'; language: string; source: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'item'; depth: number; marker: string; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'rule' }
  | { kind: 'table'; header: string[]; align: Align[]; rows: string[][]; source: string }
)
type Align = 'flex-start' | 'center' | 'flex-end'

const FENCE = /^\s*(`{3,}|~{3,})/
// The fences the reply-media mod draws as pictures: left as text, so that it
// gets them whichever of the two mods sits above the other. It reads fences of
// three backticks only; a `~~~` or longer one is code here.
const PICTURED = /^(mermaid|math)$/
// A `$$` formula's first and last line, as the reply-media mod reads them: the
// lines between are kept as text too, though one may look like a list item.
const FORMULA = /^\$\$[ \t]*$/
const RULE = /^ {0,3}([-*_])( *\1){2,} *$/
const HEADING = /^(#{1,6})\s+(.+?)[\s#]*$/
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const QUOTE = /^ {0,3}> ?(.*)$/
// A table's second line: `| --- | :-: |`, its colons the columns' alignment.
const DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/
// A column narrower than this is not worth a table: the engine draws it.
const MIN_COLUMN = 6
// ponytail: what takes two columns is told by range (CJK, Hangul, full-width
// forms, emoji), not by the Unicode width tables; a cell measured short only
// wraps a line early. Use a width library if tables come out ragged.
const WIDE =
  /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u

// ponytail: every unescaped `|` ends a cell, one inside a code span too.
const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map(cell => cell.trim().replaceAll('\\|', '|'))

/** A cell's text as it reads once drawn: its links and inline marks gone. */
const plain = (cell: string) =>
  cell.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*|__|~~|`/g, '')

const width = (text: string) =>
  [...text].reduce((sum, char) => sum + (WIDE.test(char) ? 2 : 1), 0)

/**
 * Each column's width: that of its widest cell, the widest columns narrowed
 * until the table is `room` columns wide; undefined when it cannot be.
 */
function fit(table: { header: string[]; rows: string[][] }, room: number) {
  const widths = table.header.map((_, column) =>
    Math.max(1, ...[table.header, ...table.rows].map(row => width(plain(row[column] ?? '')))),
  )
  // Each column has a bar and a space either side of its text; one bar ends the row.
  const available = room - (3 * widths.length + 1)

  while (widths.reduce((sum, each) => sum + each, 0) > available) {
    const widest = Math.max(...widths)
    if (widest <= MIN_COLUMN) {
      return undefined
    }
    widths[widths.indexOf(widest)] = widest - 1
  }

  return widths
}

// ponytail: a line-based split, not a markdown parser. Only headings, list
// items, quotes, rules, tables and closed code fences become blocks of the
// mod's; paragraphs stay raw text the engine draws. A quote ends at its last `>`
// line. Use a real parser if that leaks.
// A Button's key, from what it copies: a reply is drawn in parts when two mods
// draw it between them, so a count kept by one part would repeat in the next.
const hash = (text: string) =>
  ([...text].reduce((sum, char) => (Math.imul(sum, 31) + char.charCodeAt(0)) | 0, 0) >>> 0).toString(36)

function parse(text: string): Block[] {
  const blocks: Block[] = []
  let raw: string[] = []
  let hasGapAboveRaw = false
  let fence: string | undefined
  let wasBlank = false

  const flush = () => {
    const body = raw.join('\n').replace(/^\n+|\s+$/g, '')
    if (body !== '') {
      blocks.push({ kind: 'raw', text: body, hasGapAbove: hasGapAboveRaw })
    }
    raw = []
  }
  const keep = (line: string) => {
    if (raw.length === 0) {
      hasGapAboveRaw = wasBlank
    }
    raw.push(line)
  }

  const lines = text.split('\n')

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    const below = lines[index + 1] ?? ''
    const isBlank = line.trim() === ''
    const heading = HEADING.exec(line)
    const item = ITEM.exec(line)
    const quote = QUOTE.exec(line)
    const last = blocks.at(-1)

    if (fence !== undefined) {
      keep(line)
      // Closed by a run of the same character at least as long, alone on its line.
      const run = FENCE.exec(line)?.[1] ?? (FORMULA.test(line) ? '$$' : '')
      const isClose = run[0] === fence[0] && run.length >= fence.length && line.trim() === run
      const [open = '', ...body] = raw.slice(0, -1)
      const language = open.trim().slice(fence.length).trim().split(/\s+/)[0] ?? ''
      if (isClose && fence !== '$$' && !(fence === '```' && PICTURED.test(language))) {
        // A fence still open when the text ends (a reply mid-stream) stays
        // raw: `raw` holds it from its opening line on.
        const indent = open.length - open.trimStart().length
        blocks.push({
          kind: 'code',
          language,
          source: body.map(each => each.replace(new RegExp(`^\\s{0,${indent}}`), '')).join('\n'),
          hasGapAbove: hasGapAboveRaw,
        })
        raw = []
      }
      fence = isClose ? undefined : fence
    } else if (FENCE.test(line) || FORMULA.test(line)) {
      flush()
      keep(line)
      fence = FENCE.exec(line)?.[1] ?? '$$'
    } else if (
      line.includes('|') &&
      DELIMITER.test(below) &&
      cells(line).length > 1 &&
      cells(line).length === cells(below).length
    ) {
      flush()
      const header = cells(line)
      const align = cells(below).map(
        (mark): Align =>
          !mark.endsWith(':') ? 'flex-start' : mark.startsWith(':') ? 'center' : 'flex-end',
      )
      let end = index + 2
      while ((lines[end] ?? '').includes('|')) {
        end++
      }
      const rows = lines
        .slice(index + 2, end)
        .map(row => header.map((_, column) => cells(row)[column] ?? ''))
      const source = lines.slice(index, end).join('\n')
      blocks.push({ kind: 'table', header, align, rows, source, hasGapAbove: wasBlank })
      index = end - 1
    } else if (quote && last?.kind === 'quote' && raw.length === 0 && !wasBlank) {
      last.text += '\n' + (quote[1] ?? '')
    } else if (quote) {
      flush()
      blocks.push({ kind: 'quote', text: quote[1] ?? '', hasGapAbove: wasBlank })
    } else if (RULE.test(line)) {
      flush()
      blocks.push({ kind: 'rule', hasGapAbove: wasBlank })
    } else if (heading) {
      flush()
      const [, hashes = '', title = ''] = heading
      blocks.push({ kind: 'heading', level: hashes.length, text: title, hasGapAbove: wasBlank })
    } else if (item) {
      flush()
      const [, indent = '', marker = '', body = ''] = item
      const depth = Math.min(6, Math.floor(indent.replaceAll('\t', '  ').length / 2))
      blocks.push({ kind: 'item', depth, marker, text: body, hasGapAbove: wasBlank })
    } else if (last?.kind === 'item' && raw.length === 0 && !wasBlank && /^\s+\S/.test(line)) {
      last.text += '\n' + line.trim() // an item's wrapped line
    } else if (!isBlank || raw.length > 0) {
      keep(line)
    }

    wasBlank = isBlank
  }

  flush()

  return blocks
}

/** The switch a block is drawn under; undefined for raw text. */
function switchOf(block: Block): Switch | undefined {
  switch (block.kind) {
    case 'heading':
      return 'headings'
    case 'item':
      return 'lists'
    case 'quote':
      return ALERT.test(block.text) ? 'callouts' : 'quotes'
    case 'table':
      return 'tables'
    case 'rule':
      return 'rules'
    case 'code':
      return 'codeCards'
    default:
      return undefined
  }
}

/** A block as markdown again, near enough to what was written for the engine to draw it. */
function markdownOf(block: Block): string {
  switch (block.kind) {
    case 'raw':
      return block.text
    case 'heading':
      return `${'#'.repeat(block.level)} ${block.text}`
    case 'item': {
      const indent = ' '.repeat(block.depth * 2)

      return block.text
        .split('\n')
        .map((line, index) => (index === 0 ? `${indent}${block.marker} ${line}` : `${indent}  ${line}`))
        .join('\n')
    }
    case 'quote':
      return block.text
        .split('\n')
        .map(line => `> ${line}`)
        .join('\n')
    case 'table':
      return block.source
    case 'rule':
      return '---'
    case 'code': {
      // Longer than any run of backticks inside, so that the fence holds.
      const ticks = '`'.repeat(Math.max(3, ...(block.source.match(/`+/g) ?? []).map(run => run.length + 1)))

      return `${ticks}${block.language}\n${block.source}\n${ticks}`
    }
  }
}

/** The blocks with each one switched off made raw text again, joined to the raw text beside it. */
function restyle(blocks: Block[], off: ReadonlySet<Switch>) {
  const kept: Block[] = []
  for (const block of blocks) {
    const name = switchOf(block)
    const each: Block =
      name !== undefined && off.has(name) ? { kind: 'raw', text: markdownOf(block), hasGapAbove: block.hasGapAbove } : block
    const last = kept.at(-1)
    if (each.kind === 'raw' && last?.kind === 'raw') {
      last.text += (each.hasGapAbove ? '\n\n' : '\n') + each.text
    } else {
      kept.push(each)
    }
  }

  return kept
}

// CommonMark closes a `**` only where punctuation inside it does not meet a
// letter outside, and Chinese sets no space after its stops: `**收斂。**記憶`
// is drawn as written. Moving the punctuation out (`**收斂**。記憶`) draws it
// bold. A code span is matched first and kept whole, inside bold or not.
// ponytail: one line at a time, single-backtick code spans inside bold; a
// bold run across a line break, and `***bold italic***`, are left as written.
const BOLD = /(`+)[^`\n]*?\1(?!`)|\*\*((?:(?!\*)\p{P})*)((?:`[^`\n]*`|[^*`\n])*?)((?:(?!\*)\p{P})*)\*\*/gu
const ENDS_IN_LETTER = /[^\s\p{P}\p{S}]$/u
const STARTS_WITH_LETTER = /^[^\s\p{P}\p{S}]/u

/** The text with each bold run closable, its fences and `$$` formulas left as written. */
function holdBold(text: string) {
  let fence: string | undefined

  return text
    .split('\n')
    .map(line => {
      const run = FENCE.exec(line)?.[1] ?? (FORMULA.test(line) ? '$$' : undefined)
      if (fence !== undefined) {
        if (run !== undefined && run[0] === fence[0] && run.length >= fence.length && line.trim() === run) {
          fence = undefined
        }

        return line
      }
      fence = run

      return run !== undefined
        ? line
        : line.replace(BOLD, (whole, ticks?: string, lead = '', body = '', trail = '', at = 0) => {
            const isStuck =
              (lead !== '' && ENDS_IN_LETTER.test(line.slice(0, at))) ||
              (trail !== '' && STARTS_WITH_LETTER.test(line.slice(at + whole.length)))

            return ticks !== undefined || !isStuck || body === '' || body.trim() !== body
              ? whole
              : `${lead}**${body}**${trail}`
          })
    })
    .join('\n')
}

export const register: Register = (on, options) => {
  if (options.enabled === false) {
    return
  }

  // A style the settings do not hold, or one the mod does not draw, is the
  // default: for a table, no frame (`rules`).
  const frame = FRAME[String(options.tableBorder)]
  const cardBorder = String(options.cardBorder) in FRAME ? String(options.cardBorder) : 'round'
  const off = new Set(SWITCHES.filter(name => options[name] === false))
  const told = forms(off)

  // Told only where a terminal draws the reply: under `-p`, the SDK or an app
  // the forms would not be drawn.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const isDrawn = e.surfaces.includes('terminal')

    return isDrawn && told !== undefined
      ? { sections: [...composed.sections, { id: 'reply-markdown:forms', text: told, scope: 'session' }] }
      : composed
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isSummary) {
      return next(e)
    }

    const text = holdBold(e.props.text)
    const blocks = restyle(parse(text), off)

    if (blocks.every(block => block.kind === 'raw')) {
      return next({ ...e, props: { ...e.props, text } })
    }

    const { Box, Button, Code, Markdown, Text } = $.ui.resolve(e)
    // The engine wraps its own prose at the `maxProseWidth` setting; the mod's
    // blocks keep to the same width.
    const { maxProseWidth } = await $.settings.read()
    const room = Math.max(10, (e.viewport?.columns ?? 80) - 6)
    const columns = typeof maxProseWidth === 'number' ? Math.min(room, maxProseWidth) : room
    const rows: RenderElement[] = []

    for (const [index, block] of blocks.entries()) {
      const isSpaced = block.hasGapAbove || block.kind === 'heading'
      const marginTop = index > 0 && isSpaced ? 1 : 0

      // The engine draws what the mod does not restyle, without its bullet
      // and under a blank row of its own.
      const unstyled = (text: string) =>
        next({ ...e, props: { ...e.props, text, isFirstOfReply: false } })

      if (block.kind === 'raw') {
        rows.push(await unstyled(block.text))
      } else if (block.kind === 'code') {
        const { source } = block
        rows.push(
          <Box
            flexDirection="column"
            marginTop={marginTop}
            paddingX={1}
            width={columns}
            borderStyle={cardBorder}
            borderColor={COLOR.rule}
          >
            <Box flexDirection="row" justifyContent="space-between">
              <Text dimColor>{block.language || 'text'}</Text>
              <Button
                key={`copy:${hash(source)}`}
                label="copy"
                plain
                dimColor
                onPress={async press => {
                  const copied = await $.ui.copy({ text: source, surface: press.surface })
                  $.ui.toast(copied.isCopied ? 'Copied' : `Not copied: ${copied.reason}`)
                }}
              />
            </Box>
            <Code source={source} language={block.language || undefined} />
          </Box>,
        )
      } else if (block.kind === 'table') {
        const widths = fit(block, columns)
        if (widths === undefined) {
          rows.push(await unstyled(block.source))
          continue
        }

        // The frame is drawn as text, so that its lines meet in the right
        // glyphs; a bar spans its row's height however the cells wrap.
        const upright = frame && bar(frame.bar)
        const rule = (text: string, color: string) => (
          <Text color={color} wrap="truncate-end">
            {text}
          </Text>
        )
        const edge = ([left = '', cross = '', right = '']: string, line: string) =>
          rule(left + widths.map(each => line.repeat(each + 2)).join(cross) + right, COLOR.rule)
        const offsets = widths.map((_, column) =>
          widths.slice(0, column).reduce((sum, each) => sum + each + 3, 0),
        )
        const total = widths.reduce((sum, each) => sum + each + 3, 1)
        const row = (texts: string[], isHeader: boolean) => (
          <Box flexDirection="row" width={total}>
            {upright &&
              [...offsets, total - 1].map(left => (
                <Box position="absolute" top={0} bottom={0} left={left} width={1} overflow="hidden">
                  <Text color={COLOR.rule}>{upright}</Text>
                </Box>
              ))}
            {widths.map((each, column) => (
              <Box
                flexDirection="column"
                alignItems={block.align[column]}
                width={each + 3}
                paddingLeft={2}
                paddingRight={1}
              >
                {isHeader ? (
                  <Text bold color={COLOR.h3}>
                    {plain(texts[column] ?? '')}
                  </Text>
                ) : (
                  <Markdown text={texts[column] ?? ''} />
                )}
              </Box>
            ))}
          </Box>
        )
        const body = block.rows.map(texts => row(texts, false))
        rows.push(
          <Box flexDirection="column" marginTop={marginTop}>
            {frame
              ? [
                  edge(frame.edges[0], frame.line),
                  row(block.header, true),
                  edge(frame.edges[1], frame.line),
                  ...body,
                  edge(frame.edges[2], frame.line),
                ]
              : [
                  row(block.header, true),
                  rule('━'.repeat(total), COLOR.headRule),
                  ...body.flatMap((each, index) =>
                    index === 0 ? [each] : [rule('─'.repeat(total), COLOR.rowRule), each],
                  ),
                ]}
          </Box>,
        )
      } else if (block.kind === 'rule') {
        rows.push(
          <Box marginTop={marginTop}>
            <Text color={COLOR.rule} wrap="truncate-end">
              {'─'.repeat(columns)}
            </Text>
          </Box>,
        )
      } else if (block.kind === 'heading') {
        const title = block.text.replace(/\*\*|`/g, '')
        const color = [COLOR.h2, COLOR.h3, COLOR.h4][Math.min(block.level, 4) - 2]
        rows.push(
          <Box marginTop={marginTop}>
            {block.level === 1 ? (
              <Text bold color={COLOR.ink} backgroundColor={COLOR.h1}>
                {` ${title} `}
              </Text>
            ) : (
              <Text bold color={color}>
                {block.level === 2 ? '▌ ' : ''}
                {title}
              </Text>
            )}
          </Box>,
        )
      } else if (block.kind === 'quote' && ALERT.test(block.text)) {
        const [marker = '', name = ''] = ALERT.exec(block.text) ?? []
        const { label = name, color } = CALLOUT[name.toUpperCase()] ?? {}
        const body = block.text.slice(marker.length)
        rows.push(
          <Box
            flexDirection="column"
            marginTop={marginTop}
            paddingX={1}
            width={columns}
            borderStyle={cardBorder}
            borderColor={color}
          >
            <Text bold color={color}>
              {label}
            </Text>
            {body.trim() !== '' && <Markdown text={body} />}
          </Box>,
        )
      } else if (block.kind === 'quote') {
        // The bar spans the quote's rows however its text wraps.
        rows.push(
          <Box marginTop={marginTop} paddingLeft={2} width={columns}>
            <Box position="absolute" top={0} bottom={0} left={0} width={1} overflow="hidden">
              <Text color={COLOR.quote}>{BAR}</Text>
            </Box>
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              <Markdown text={block.text} dimColor />
            </Box>
          </Box>,
        )
      } else {
        const isOrdered = /\d/.test(block.marker)
        const bullet = block.depth === 0 ? '•' : '◦'
        // A task: `- [ ] todo`, `- [x] done`.
        const [, state, todo] = TASK.exec(block.text) ?? []
        const isDone = state !== undefined && state !== ' '
        rows.push(
          <Box flexDirection="row" marginTop={marginTop} paddingLeft={block.depth * 2} width={columns}>
            {state === undefined ? (
              <Text color={isOrdered ? COLOR.number : COLOR.bullet}>
                {isOrdered ? block.marker : bullet}{' '}
              </Text>
            ) : (
              <Text color={isDone ? COLOR.bullet : COLOR.rule}>{isDone ? '☑ ' : '☐ '}</Text>
            )}
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              <Markdown text={todo ?? block.text} />
            </Box>
          </Box>,
        )
      }
    }

    // A reply sits one row under what precedes it: the engine's own text
    // brings that row, a block of the mod's needs it given.
    const hasOwnRowAbove = blocks[0]?.kind === 'raw'

    return (
      <Box flexDirection="row" marginTop={hasOwnRowAbove ? 0 : 1}>
        {e.props.isFirstOfReply && (
          <Box marginTop={hasOwnRowAbove ? 1 : 0}>
            <Text color="text">⏺ </Text>
          </Box>
        )}
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {rows}
        </Box>
      </Box>
    )
  })
}
