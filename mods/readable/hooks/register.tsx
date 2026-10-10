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
  quote: '#ff60ff',
  ink: '#e8fe96',
} as const
// ponytail: the bar beside a quote is this many rows, clipped to the quote;
// a taller quote runs out of bar.
const QUOTE_ROWS = 200

type Block = { hasGapAbove: boolean } & (
  | { kind: 'raw'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'item'; depth: number; marker: string; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'rule' }
)

const FENCE = /^\s*(`{3,}|~{3,})/
const RULE = /^ {0,3}([-*_])( *\1){2,} *$/
const HEADING = /^(#{1,6})\s+(.+?)[\s#]*$/
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const QUOTE = /^ {0,3}> ?(.*)$/

// ponytail: a line-based split, not a markdown parser. Only headings, list
// items, quotes and rules become blocks of the mod's; code fences, tables and
// paragraphs stay raw text the engine draws. A quote ends at its last `>`
// line. Use a real parser if that leaks.
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

  for (const line of text.split('\n')) {
    const isBlank = line.trim() === ''
    const heading = HEADING.exec(line)
    const item = ITEM.exec(line)
    const quote = QUOTE.exec(line)
    const last = blocks.at(-1)

    if (fence !== undefined) {
      keep(line)
      // Closed by a run of the same character at least as long, alone on its line.
      const run = FENCE.exec(line)?.[1] ?? ''
      const isClose = run[0] === fence[0] && run.length >= fence.length && line.trim() === run
      fence = isClose ? undefined : fence
    } else if (FENCE.test(line)) {
      keep(line)
      fence = FENCE.exec(line)?.[1]
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

export const register: Register = on => {
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isSummary) {
      return next(e)
    }

    const blocks = parse(e.props.text)

    if (blocks.every(block => block.kind === 'raw')) {
      return next(e)
    }

    const { Box, Markdown, Text } = $.ui.resolve(e)
    // The engine wraps its own prose at the `maxProseWidth` setting; the mod's
    // blocks keep to the same width.
    const { maxProseWidth } = await $.settings.read()
    const room = Math.max(10, (e.viewport?.columns ?? 80) - 6)
    const columns = typeof maxProseWidth === 'number' ? Math.min(room, maxProseWidth) : room
    const rows: RenderElement[] = []

    for (const [index, block] of blocks.entries()) {
      const isSpaced = block.hasGapAbove || block.kind === 'heading'
      const marginTop = index > 0 && isSpaced ? 1 : 0

      if (block.kind === 'raw') {
        // The engine draws what the mod does not restyle, without its bullet
        // and under a blank row of its own.
        const props = { ...e.props, text: block.text, isFirstOfReply: false }
        rows.push(await next({ ...e, props }))
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
      } else if (block.kind === 'quote') {
        // The bar spans the quote's rows however its text wraps.
        rows.push(
          <Box marginTop={marginTop} paddingLeft={2} width={columns}>
            <Box position="absolute" top={0} bottom={0} left={0} width={1} overflow="hidden">
              <Text color={COLOR.quote}>{Array(QUOTE_ROWS).fill('│').join('\n')}</Text>
            </Box>
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              <Markdown text={block.text} dimColor />
            </Box>
          </Box>,
        )
      } else {
        const isOrdered = /\d/.test(block.marker)
        const bullet = block.depth === 0 ? '•' : '◦'
        rows.push(
          <Box flexDirection="row" marginTop={marginTop} paddingLeft={block.depth * 2} width={columns}>
            <Text color={isOrdered ? COLOR.number : COLOR.bullet}>
              {isOrdered ? block.marker : bullet}{' '}
            </Text>
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              <Markdown text={block.text} />
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
