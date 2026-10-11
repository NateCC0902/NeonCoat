import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const SOURCE = 'flowchart LR\n  A --> B'
const TEXT = `Before\n\n\`\`\`mermaid\n${SOURCE}\n\`\`\`\n\nAfter`
const DIAGRAM = { file: '/tmp/a.png', width: 800, height: 400 }
const RAN = {
  exitCode: 0,
  stdout: '',
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
}

/**
 * Stands for the engine beneath the mod: a session in /work, and a record of
 * the text it is asked to draw.
 */
const engine = (on: On) => {
  const drawn: string[] = []
  on('session.cwd', () => ({ value: '/work' }))
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
    plugin: 'reply-media',
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

test('a fence that did not render is boxed in the error color, with its reason', async ($, on) => {
  // What node writes when a script throws: where, then the error, then its
  // stack. Two `Error:` when the tool the script ran says it too, as sips does.
  const stderr =
    'file:///mod/render/render.mjs:102\n  rasterize(\n  ^\n\nError: Error: bad diagram\n    at file:///mod/render/render.mjs:102:3\n'
  on('process.run', () => ({ value: { ...RAN, exitCode: 1, stderr } }))
  const drawn = engine(on)
  const ui = await reply($, 'row-2')

  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(drawn).toEqual(['Before', 'After'])
  expect((await ui.find({ type: 'Text', text: /^✗ not drawn: bad diagram$/ }))?.props).toMatchObject({
    color: 'error',
  })
  expect((await ui.findAll({ type: 'Box' })).some(box => box.props.borderColor === 'error')).toBe(true)
  expect(await ui.find({ type: 'Text', text: SOURCE })).toBeDefined()
  await ui.unmount()
})

test('a picture whose file was swept is drawn again from its block', async ($, on) => {
  const clock = mock.clock(on)
  let ran = 0
  on('process.run', () => {
    // The reply's own render, then the one that makes the swept picture again.
    ran += 1
    const file = ran === 1 ? '/tmp/swept.png' : '/tmp/again.png'

    return { value: { ...RAN, stdout: JSON.stringify({ ...DIAGRAM, file }) } }
  })
  on('fs.stat', (_, e) =>
    e.path === '/tmp/swept.png'
      ? { deny: 'ENOENT' }
      : { value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false } },
  )
  engine(on)
  const ui = await reply($, 'row-swept')
  await clock.settle()

  expect(ran).toBe(2)
  expect((await ui.find({ type: 'Image' }))?.props.source).toMatchObject({ file: '/tmp/again.png' })
  await ui.unmount()
})

const source = (name: string) => `flowchart LR\n  ${name} --> Z`

/**
 * Stands for a resumed session of four replies, each one diagram, and starts
 * it; answers the sources the mod rendered, in order.
 */
const resume = async ($: Engine, on: On) => {
  const rendered: (string | undefined)[] = []
  engine(on)
  on('session.messages', () => ({
    value: [
      { role: 'user' as const, text: 'draw them', toolUses: [] },
      ...['old', 'a', 'b', 'c'].map(name => ({
        role: 'assistant' as const,
        text: `\`\`\`mermaid\n${source(name)}\n\`\`\``,
        toolUses: [],
      })),
    ],
  }))
  on('process.run', (_, e) => {
    rendered.push(e.init?.stdin)

    return { value: { ...RAN, stdout: JSON.stringify(DIAGRAM) } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  return rendered
}

test('a resumed session gets pictures for its last three replies only', async ($, on) => {
  expect(await resume($, on)).toEqual(['a', 'b', 'c'].map(source))
})

test('the number of replies redrawn on resume is an option', { options: { resumedReplies: 1 } }, async ($, on) => {
  expect(await resume($, on)).toEqual([source('c')])
})

test('zero redraws none', { options: { resumedReplies: 0 } }, async ($, on) => {
  expect(await resume($, on)).toEqual([])
})

const MIXED = [
  'A formula:',
  '```math\n\\frac{a}{b}\n```',
  '$$\nE = mc^2\n$$',
  '![chart](plots/chart.png)',
  '```mathematica\nPlot[Sin[x], {x, 0, 2 Pi}]\n```',
  '```md\n![not drawn](inside/a/fence.png)\n```',
  '![remote](https://example.com/x.png)',
].join('\n\n')

/** Appends `text` as the model's reply, then draws its row on the terminal. */
const show = async ($: Engine, text: string) => {
  await $.session.append({
    door: 'response',
    origin: { kind: 'model', model: 'test' },
    uuid: 'row-mixed',
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
  })

  return $.ui.mount({
    plugin: 'reply-media',
    surface: 'terminal',
    component: 'AssistantMessage',
    props: { text, isFirstOfReply: true },
  })
}

test('formulas and local images are drawn too, each by its own script', async ($, on) => {
  const ran: [script: string | undefined, stdin: string | undefined, cwd: string | undefined][] = []
  on('process.run', (_, e) => {
    ran.push([e.argv[1]?.split('/').at(-1), e.init?.stdin, e.init?.cwd])

    return { value: { ...RAN, stdout: JSON.stringify(DIAGRAM) } }
  })
  const drawn = engine(on)
  const ui = await show($, MIXED)

  expect(ran).toEqual([
    ['math.mjs', '\\frac{a}{b}', '/work'],
    ['math.mjs', 'E = mc^2', '/work'],
    ['picture.mjs', 'plots/chart.png', '/work'],
  ])
  expect((await ui.findAll({ type: 'Image' })).map(image => image.props.alt)).toEqual([
    '\\frac{a}{b}',
    'E = mc^2',
    'plots/chart.png',
  ])
  // What is not drawn is the engine's, as written: the two fences that only
  // look like a formula or hold an image, and the remote image.
  expect(drawn.at(-1)).toBe(MIXED.split('\n\n').slice(-3).join('\n\n'))
  await ui.unmount()
})

test('a picture is sized by the cell options', { options: { pxPerColumn: 16, cellAspect: 2 } }, async ($, on) => {
  on('process.run', () => ({ value: { ...RAN, stdout: JSON.stringify(DIAGRAM) } }))
  engine(on)
  const ui = await reply($, 'row-sized')

  // 800 px at 16 px a column is 50 columns, so 12.5 rows on cells twice as
  // tall as wide: 13 whole rows, and the 52 columns that keep the 2:1 shape.
  expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({ columns: 52, rows: 13 })
  await ui.unmount()
})

test('draws nothing when turned off', { options: { enabled: false } }, async ($, on) => {
  const drawn = engine(on)
  const ui = await reply($, 'row-off')

  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(drawn).toEqual([TEXT])
  await ui.unmount()
})

test('a picture has buttons that copy its source and open it in a pane', async ($, on) => {
  const copied: string[] = []
  const opened: { id: string; closeOnEscape?: true }[] = []
  on('ui.copy', (_, e) => {
    copied.push(e.text)

    return { value: { isCopied: true as const } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', (_, e) => {
    opened.push(e)

    return { value: { isPlaced: true as const } }
  })
  on('process.run', () => {
    const diagram = { file: '/tmp/a.png', width: 800, height: 400 }

    return { value: { ...RAN, stdout: JSON.stringify(diagram) } }
  })
  engine(on)
  const pane = (bodyColumns: number, bodyRows: number) =>
    $.ui.mount({
      plugin: 'reply-media',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'picture-zoom',
      props: {
        title: 'Picture',
        isFocused: false,
        bodyColumns,
        placement: 'dock',
        scroll: { offset: 0, bodyRows },
        view: {},
      },
    })
  const empty = await pane(60, 40)
  expect(await empty.find({ type: 'Image' })).toBeUndefined()
  await empty.unmount()

  const ui = await reply($, 'uuid-zoom')
  const keys = (await ui.findAll({ type: 'Button' })).map(button => String(button.props.key))
  expect(keys.map(key => key.split(':')[0])).toEqual(['copy', 'zoom'])

  await ui.press({ key: keys[0] ?? '' })
  expect(copied).toEqual([SOURCE])

  await ui.press({ key: keys[1] ?? '' })
  expect(opened).toHaveLength(1)
  expect(opened[0]).toMatchObject({ id: 'picture-zoom', closeOnEscape: true })

  // As wide as the pane, or as tall as it when that comes first; 2:1 kept.
  const wide = await pane(60, 40)
  expect((await wide.find({ type: 'Image' }))?.props).toMatchObject({ columns: 60, rows: 14 })
  await wide.unmount()
  const short = await pane(120, 10)
  expect((await short.find({ type: 'Image' }))?.props).toMatchObject({ columns: 43, rows: 10 })
  await short.unmount()
  await ui.unmount()
})

test('a video is drawn as its first frame, and plays frame by frame once it is cut', async ($, on) => {
  const clock = mock.clock(on)
  const ran: (string | undefined)[][] = []
  const swapped: string[] = []
  on('process.run', (_, e) => {
    ran.push([e.argv[1]?.split('/').at(-1), ...e.argv.slice(2), e.init?.stdin])
    const printed =
      e.argv[2] === 'frames'
        ? { dir: '/tmp/clip', count: 3, fps: 10 }
        : { file: '/tmp/clip/f00001.png', width: 960, height: 540, clip: '/work/demo.mp4' }

    return { value: { ...RAN, stdout: JSON.stringify(printed) } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.blit', (_, e) => {
    swapped.push('source' in e && 'file' in e.source ? `${e.requestId} ${e.source.file}` : '')

    return { value: {} }
  })
  engine(on)
  const text = 'A recording:\n\n![demo](demo.mp4)'
  await $.session.append({
    door: 'response',
    origin: { kind: 'model', model: 'test' },
    uuid: 'row-video',
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
  })
  const ui = await $.ui.mount({
    plugin: 'reply-media',
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId: 'row-video',
    props: { text, isFirstOfReply: true },
  })
  const buttons = async () => (await ui.findAll({ type: 'Button' })).map(button => button.props)
  const play = String((await buttons())[0]?.key)

  // Only the first frame is made for the reply: the cut waits for a play.
  expect(ran).toEqual([['video.mjs', 'demo.mp4']])
  expect((await ui.find({ type: 'Image' }))?.props.source).toMatchObject({ file: '/tmp/clip/f00001.png' })
  expect((await buttons()).map(button => button.label)).toEqual(['▶ play', 'copy path', 'open'])

  await ui.press({ key: play })
  expect(ran.at(-1)).toEqual(['video.mjs', 'frames', '/work/demo.mp4'])
  expect((await buttons())[0]?.label).toBe('❚❚ pause')

  // Three frames at ten a second, then it stops by itself.
  await clock.advance(300)
  expect(swapped).toEqual([1, 2, 3].map(frame => `row-video /tmp/clip/f0000${frame}.png`))
  expect((await buttons())[0]?.label).toBe('▶ play')

  // Played again from the start, without a second cut; a press pauses it,
  // and the next one goes on from the frame it stopped at.
  await ui.press({ key: play })
  await clock.advance(200)
  await ui.press({ key: play })
  await clock.advance(300)
  expect(swapped.slice(3)).toEqual([1, 2].map(frame => `row-video /tmp/clip/f0000${frame}.png`))
  expect((await ui.find({ type: 'Image' }))?.props.source).toMatchObject({ file: '/tmp/clip/f00002.png' })
  await ui.press({ key: play })
  await clock.advance(200)
  expect(swapped.slice(5)).toEqual([2, 3].map(frame => `row-video /tmp/clip/f0000${frame}.png`))
  expect(ran).toHaveLength(2)
  await ui.unmount()
})
