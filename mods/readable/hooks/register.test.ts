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
    plugin: 'readable',
    surface: 'terminal',
    component: 'AssistantMessage',
    props: { text, isFirstOfReply: true },
  })

test('headings, list items and rules are the mod\'s, the rest the engine\'s', async ($, on) => {
  const drawn = engine(on)
  const ui = await mount($, TEXT)
  const shown = async (text: string) => (await ui.find({ type: 'Text', text }))?.props
  const items = await ui.findAll({ type: 'Markdown' })

  expect(drawn).toEqual(['Intro paragraph.', CODE])
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

  expect(drawn).toEqual([nested])
  expect(await ui.findAll({ type: 'Text', text: /heading|code/ })).toHaveLength(1)
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
  expect(drawn).toEqual(['After.\n\n```\n> code\n```'])
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
  const ui = await mount($, `Just a paragraph.\n\n${CODE}`)

  expect(drawn).toEqual([`Just a paragraph.\n\n${CODE}`])
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
  await ui.unmount()
})
