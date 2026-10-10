import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const SOURCE = 'flowchart LR\n  A --> B'
const TEXT = `Before\n\n\`\`\`mermaid\n${SOURCE}\n\`\`\`\n\nAfter`
const RAN = {
  exitCode: 0,
  stdout: '',
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
}

/** Stands for the engine beneath the mod: records the text it is asked to draw. */
const engine = (on: On) => {
  const drawn: string[] = []
  on('ui.render', { component: 'AssistantMessage' }, (_, e) => {
    drawn.push(e.props.text)

    return { type: 'engine', ref: 0 }
  })

  return drawn
}

/** Appends the reply as the model's, then draws its row on the terminal. */
const reply = async ($: Engine, uuid: string) => {
  await $.session.append({
    door: 'response',
    origin: { kind: 'model', model: 'test' },
    uuid,
    message: {
      type: 'assistant',
      role: 'assistant',
      content: [{ type: 'text', text: TEXT }],
    },
  })

  return $.ui.mount({
    plugin: 'mermaid',
    surface: 'terminal',
    component: 'AssistantMessage',
    props: { text: TEXT, isFirstOfReply: true },
  })
}

test('a mermaid fence of a reply is drawn as an Image once rendered', async ($, on) => {
  const ran: (readonly string[])[] = []
  on('process.run', (_, e) => {
    ran.push(e.argv)
    const diagram = { file: '/tmp/a.png', width: 800, height: 400 }

    return { value: { ...RAN, stdout: JSON.stringify(diagram) } }
  })
  const drawn = engine(on)
  const ui = await reply($, 'row-1')
  const image = await ui.find({ type: 'Image' })

  expect(ran).toHaveLength(1)
  expect(ran[0]?.[1]).toMatch(/render\/render\.mjs$/)
  expect(drawn).toEqual(['Before', 'After'])
  expect(image?.props).toMatchObject({
    source: { file: '/tmp/a.png', format: 'png' },
    columns: 76, // the 80-column default less its margin
    rows: 18,
    alt: SOURCE,
  })
  await ui.unmount()
})

test("a fence that did not render stays the engine's own drawing", async ($, on) => {
  on('process.run', () => ({
    value: { ...RAN, exitCode: 1, stderr: 'bad diagram' },
  }))
  const drawn = engine(on)
  const ui = await reply($, 'row-2')

  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(drawn).toEqual([TEXT])
  await ui.unmount()
})
