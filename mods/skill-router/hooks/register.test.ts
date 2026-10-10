import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptComposeTrait } from 'claude-code'

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

const compose = ($: Engine, traits: PromptComposeTrait[] = []) =>
  $.prompt.compose({
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: ['terminal'],
    tools: [],
    outputStyle: null,
    traits,
  })

test('lists the skills only the user can run, last in the prompt', async ($, on) => {
  engine(on)
  const { sections } = await compose($)
  const rows = sections.at(-1)?.text.split('\n').filter(line => line.startsWith('- /'))

  expect(sections.map(section => section.id)).toEqual(['intro', 'skill-router:index'])
  expect(sections.at(-1)?.scope).toBe('session')
  expect(rows).toEqual([
    '- /grill-me: A relentless interview.',
    '- /simplify',
    `- /tdd: ${LONG.slice(0, 120).trimEnd()}…`,
  ])
})

test('adds nothing to a bare prompt, or when no skill is user-only', async ($, on) => {
  engine(on, { 'grill-me': 'off', retired: 'off' })

  expect((await compose($, ['bare'])).sections).toHaveLength(1)
  expect((await compose($)).sections).toHaveLength(1)
})

test('a failed read is shown once and tried again on the next prompt', async ($, on) => {
  let isUnreadable = true
  const logged: string[] = []
  on('ui.log', (_, e) => {
    logged.push(e.text)

    return { value: undefined }
  })
  engine(on, OVERRIDES, () => isUnreadable)

  expect((await compose($)).sections).toHaveLength(1)
  expect((await compose($)).sections).toHaveLength(1)
  expect(logged).toHaveLength(1)
  expect(logged[0]).toMatch(/^skill-router: .*EACCES/)

  isUnreadable = false
  expect((await compose($)).sections).toHaveLength(2)
})
