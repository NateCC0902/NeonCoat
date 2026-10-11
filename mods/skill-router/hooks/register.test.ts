import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const SKILLS = '/home/u/.claude/skills'
const LONG = 'Test-first. '.repeat(20).trim()
const FILES: Record<string, string> = {
  'grill-me': 'name: grill-me\ndescription: A relentless interview.\ndisable-model-invocation: true',
  tdd: `name: tdd\ndescription: "${LONG}"`,
  research: 'name: research\ndescription: Claude can invoke this one itself.',
  retired: 'name: retired\ndescription: Out of the menu.\ndisable-model-invocation: true',
  notes: '',
}
const OVERRIDES = { tdd: 'user-invocable-only', simplify: 'user-invocable-only', retired: 'off' }

/**
 * Stands for the engine beneath the mod: a home folder of skills, the
 * settings, and a system prompt of one section.
 */
const engine = (
  on: On,
  overrides: Record<string, string> = OVERRIDES,
  isUnreadable: () => boolean = () => false,
) => {
  on('env.get', () => ({ value: '/home/u' }))
  on('settings.read', () => ({ value: { skillOverrides: overrides } }))
  on('fs.list', () =>
    isUnreadable()
      ? { deny: 'EACCES: the skills folder' }
      : {
          value: Object.keys(FILES).map(name => ({
            name,
            kind: 'other' as const,
            size: 0,
            mtimeMs: 0,
            isLink: true,
          })),
        },
  )
  on('fs.read', (_, e) => {
    const frontmatter = FILES[e.path.slice(SKILLS.length + 1, -'/SKILL.md'.length)]

    return frontmatter === undefined || frontmatter === ''
      ? { deny: `ENOENT: ${e.path}` }
      : { value: `---\n${frontmatter}\n---\n\n# Body\n` }
  })
  on('prompt.compose', () => ({
    sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' as const }],
  }))
}

const compose = ($: Engine) =>
  $.prompt.compose({
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: ['terminal'],
    tools: [],
    outputStyle: null,
    traits: [],
  })

/** Starts a session, and records the commands the mod registers in it. */
const start = async ($: Engine, on: On) => {
  const registered: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => {
    registered.push(e.name)

    return { value: { command: e.name } }
  })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  return registered
}

const run = ($: Engine, args: string) =>
  $.command.run({
    command: 'skill-router',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 80 },
  })

test('adds nothing to the system prompt', async ($, on) => {
  engine(on)

  expect((await compose($)).sections.map(section => section.id)).toEqual(['intro'])
})

test('/skill-router has a small model pick from the list, or shows the list', async ($, on) => {
  const asked: { model: string; system?: string; prompt: string }[] = []
  engine(on)
  on('model.complete', (_, e) => {
    asked.push(e)
    const usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    }

    return { value: { isAnswered: true as const, text: '/grill-me: it tests a plan.', usage } }
  })
  await start($, on)

  expect((await run($, 'how do I stress-test a plan?')).text).toBe('/grill-me: it tests a plan.')
  expect(asked).toHaveLength(1)
  expect(asked[0]).toMatchObject({ model: 'haiku', prompt: 'how do I stress-test a plan?' })
  expect(asked[0]?.system).toMatch(/\n- \/grill-me: A relentless interview\.\n- \/simplify\n/)

  expect((await run($, '')).text?.split('\n')).toEqual([
    '- /grill-me: A relentless interview.',
    '- /simplify',
    `- /tdd: ${LONG.slice(0, 120).trimEnd()}…`,
  ])
  expect(asked).toHaveLength(1)
})

test('says so when no skill is user-only', async ($, on) => {
  engine(on, { 'grill-me': 'off', retired: 'off' })
  await start($, on)

  expect((await run($, '')).text).toBe('No skill here is one only you can run.')
})

test('a failed read is told in the answer, and the next run reads again', async ($, on) => {
  let isUnreadable = true
  engine(on, OVERRIDES, () => isUnreadable)
  await start($, on)

  expect((await run($, '')).text).toMatch(/^Reading your skills failed: .*EACCES/)

  isUnreadable = false
  expect((await run($, '')).text).toMatch(/^- \/grill-me: /)
})

test('registers no command when turned off', { options: { enabled: false } }, async ($, on) => {
  engine(on)

  expect(await start($, on)).toEqual([])
})
