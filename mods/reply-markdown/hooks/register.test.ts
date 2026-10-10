import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const CODE = '```md\n# not a heading\n- not an item\n```'
const TEXT = [
  'Intro paragraph.',
  '',
  '# Title',
  '## Section `one`',
  '- first **item**',
  '  wrapped line',
  '  - nested',
  '1. step',
  '',
  '---',
  CODE,
].join('\n')

/**
 * Stands for the engine beneath the mod: records the text it is asked to draw
 * and answers for the settings.
 */
const engine = (on: On, settings: Record<string, unknown> = {}) => {
  const drawn: string[] = []
  on('ui.render', { component: 'AssistantMessage' }, (_, e) => {
    drawn.push(e.props.text)

    return { type: 'engine', ref: 0 }
  })
  on('settings.read', () => ({ value: settings }))

  return drawn
}

const mount = ($: Engine, text: string) =>
  $.ui.mount({
    plugin: 'reply-markdown',
    surface: 'terminal',
    component: 'AssistantMessage',
    props: { text, isFirstOfReply: true },
  })

test('headings, list items and rules are the mod\'s, the rest the engine\'s', async ($, on) => {
  const drawn = engine(on)
  const ui = await mount($, TEXT)
  const shown = async (text: string) => (await ui.find({ type: 'Text', text }))?.props
  const items = await ui.findAll({ type: 'Markdown' })

  expect(drawn).toEqual(['Intro paragraph.'])
  expect((await ui.find({ type: 'Code' }))?.props).toMatchObject({
    source: '# not a heading\n- not an item',
    language: 'md',
  })
  expect(await shown(' Title ')).toMatchObject({ backgroundColor: '#6b50ff', bold: true })
  expect(await shown('▌ Section one')).toMatchObject({ color: '#ff60ff', bold: true })
  expect(await shown('• ')).toMatchObject({ color: '#00ffb2' })
  expect(await shown('◦ ')).toMatchObject({ color: '#00ffb2' })
  expect(await shown('1. ')).toMatchObject({ color: '#e8fe96' })
  expect(await shown('⏺ ')).toBeDefined()
  expect(items.map(item => item.props.text)).toEqual([
    'first **item**\nwrapped line',
    'nested',
    'step',
  ])
  expect(await ui.find({ type: 'Text', text: /^─+$/ })).toBeDefined()
  await ui.unmount()
})

test('a longer fence is not closed by a shorter one inside it', async ($, on) => {
  const nested = '````md\n```js\ncode\n```\n# still code\n````'
  const drawn = engine(on)
  const ui = await mount($, `## Real heading\n${nested}`)

  expect(drawn).toEqual([])
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe('```js\ncode\n```\n# still code')
  expect(await ui.findAll({ type: 'Text', text: /heading/ })).toHaveLength(1)
  await ui.unmount()
})

test('quote lines are one dim block beside a bar', async ($, on) => {
  const drawn = engine(on)
  const ui = await mount($, '> first **line**\n> second\n\nAfter.\n\n```\n> code\n```')

  expect((await ui.find({ type: 'Markdown' }))?.props).toMatchObject({
    text: 'first **line**\nsecond',
    dimColor: true,
  })
  expect((await ui.find({ type: 'Text', text: /^│/ }))?.props).toMatchObject({ color: '#ff60ff' })
  expect(drawn).toEqual(['After.'])
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe('> code')
  await ui.unmount()
})

test('the mod\'s blocks keep to the maxProseWidth setting', async ($, on) => {
  engine(on, { maxProseWidth: 40 })
  const ui = await mount($, '- item\n\n---')

  expect(await ui.find({ type: 'Text', text: /^─{40}$/ })).toBeDefined()
  await ui.unmount()
})

test('a reply with nothing to restyle is left to the engine whole', async ($, on) => {
  const drawn = engine(on)
  const ui = await mount($, 'Just a paragraph.\n\nAnd another, with `code` in it.')

  expect(drawn).toEqual(['Just a paragraph.\n\nAnd another, with `code` in it.'])
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
  await ui.unmount()
})

test('restyles nothing when turned off', { options: { enabled: false } }, async ($, on) => {
  const drawn = engine(on)
  const ui = await mount($, TEXT)

  expect(drawn).toEqual([TEXT])
  await ui.unmount()
})

test('an alert quote is a bordered callout, a task item a checkbox', async ($, on) => {
  engine(on)
  const ui = await mount($, '> [!WARNING]\n> Mind the **gap**.\n\n- [ ] todo\n- [x] done\n- plain')
  const label = await ui.find({ type: 'Text', text: 'Warning' })
  const boxes = await ui.findAll({ type: 'Box' })

  expect(label?.props).toMatchObject({ bold: true, color: '#f5ef34' })
  expect(boxes.some(box => box.props.borderStyle === 'round' && box.props.borderColor === '#f5ef34')).toBe(true)
  expect((await ui.findAll({ type: 'Markdown' })).map(markdown => markdown.props.text)).toEqual([
    'Mind the **gap**.',
    'todo',
    'done',
    'plain',
  ])
  expect(await ui.find({ type: 'Text', text: '☐ ' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: '☑ ' }))?.props.color).toBe('#00ffb2')
  await ui.unmount()
})

const TABLE = ['| 名稱 | Note |', '| --- | ---: |', '| `ab` | a **bold** word |', '| c | d |'].join('\n')

test('a table is a heavy frame, its header colored, its cells markdown', async ($, on) => {
  const drawn = engine(on)
  const ui = await mount($, `Before\n\n${TABLE}\n\nAfter`)
  const texts = (await ui.findAll({ type: 'Text' })).map(text => text.text)

  // 名稱 is four columns wide, `a bold word` eleven.
  expect(texts).toContain('┏━━━━━━┳━━━━━━━━━━━━━┓')
  expect(texts).toContain('┣━━━━━━╋━━━━━━━━━━━━━┫')
  expect(texts).toContain('┗━━━━━━┻━━━━━━━━━━━━━┛')
  expect((await ui.find({ type: 'Text', text: '名稱' }))?.props).toMatchObject({ bold: true })
  expect((await ui.findAll({ type: 'Markdown' })).map(markdown => markdown.props.text)).toEqual([
    '`ab`',
    'a **bold** word',
    'c',
    'd',
  ])
  expect(drawn).toEqual(['Before', 'After'])
  await ui.unmount()
})

test('a table too wide for the room is left to the engine', async ($, on) => {
  const wide = ['| one | two | three | four |', '| - | - | - | - |', '| 1 | 2 | 3 | 4 |'].join('\n')
  const drawn = engine(on, { maxProseWidth: 20 })
  const ui = await mount($, `# Title\n\n${wide}`)

  expect(drawn).toEqual([wide])
  await ui.unmount()
})

test('a code fence is a card with its language and a button that copies it', async ($, on) => {
  const copied: string[] = []
  const toasts: string[] = []
  on('ui.copy', (_, e) => {
    copied.push(e.text)

    return { value: { isCopied: true as const } }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  const drawn = engine(on)
  const ui = await mount($, 'Run it:\n\n```bash\nnpm test\n```\n\n```ts\nstill open')

  expect((await ui.find({ type: 'Code' }))?.props).toMatchObject({ source: 'npm test', language: 'bash' })
  expect(await ui.find({ type: 'Text', text: 'bash' })).toBeDefined()
  // A fence the reply has not closed yet is the engine's still.
  expect(drawn).toEqual(['Run it:', '```ts\nstill open'])

  const [button] = await ui.findAll({ type: 'Button' })
  await ui.press({ key: String(button?.props.key) })
  expect(copied).toEqual(['npm test'])
  expect(toasts).toEqual(['Copied'])
  await ui.unmount()
})

test('the same code twice in a reply, and a fence the reply-pictures mod draws', async ($, on) => {
  const picture = '```mermaid\nflowchart LR\n  A --> B\n```'
  const drawn = engine(on)
  const code = '```mathematica\nPlot[Sin[x], {x, 0, 2 Pi}]\n```'
  const ui = await mount($, `# Title\n\n\`\`\`sh\nls\n\`\`\`\n\n${picture}\n\n\`\`\`sh\nls\n\`\`\`\n\n${code}`)

  // `mathematica` only starts like `math`: it is code.
  expect((await ui.findAll({ type: 'Code' })).map(each => each.props.language)).toEqual([
    'sh',
    'sh',
    'mathematica',
  ])
  // Left to whatever sits beneath: the reply-pictures mod, else the engine.
  expect(drawn).toEqual([picture])
  await ui.unmount()
})

test(
  'the borders follow the options',
  { options: { tableBorder: 'round', cardBorder: 'bold' } },
  async ($, on) => {
    engine(on)
    const ui = await mount($, `${TABLE}\n\n\`\`\`sh\nls\n\`\`\`\n\n> [!NOTE]\n> Mind it.`)
    const texts = (await ui.findAll({ type: 'Text' })).map(text => text.text)
    const borders = (await ui.findAll({ type: 'Box' })).map(box => box.props.borderStyle).filter(Boolean)

    expect(texts).toContain('╭──────┬─────────────╮')
    expect(texts).toContain('╰──────┴─────────────╯')
    expect(texts.some(text => text.startsWith('│\n│'))).toBe(true)
    // The code card and the callout.
    expect(borders).toEqual(['bold', 'bold'])
    await ui.unmount()
  },
)
