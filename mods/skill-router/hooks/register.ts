import type { EngineInterface, Register } from 'claude-code'

const SECTION = 'skill-router:index'
// Enough of a description to tell when a skill fits: the listing rides on
// every request, so each row stays short.
const DESCRIPTION_LENGTH = 120

const INTRO = `# Skills only the user can run

The skills listed here are kept out of your skill list: you cannot invoke them, and the user starts each one by typing its slash command. The user often forgets they have them. When your conversation with the user reaches a point where one of them would help, say so in one line at the end of your reply, naming the command and why it fits now, then carry on with the task. The user decides whether to type it. Name a skill once for a given moment, and name none when nothing fits.

A skill listed with a description has its full text at ~/.claude/skills/<name>/SKILL.md. Read it when the one-line description is not enough to judge the fit. A skill listed by name alone has no file there: it is one of Claude Code's built-in commands. Do not carry a skill out from its file yourself: these are user-run because they have side effects or because the user wants to choose the moment.`

// ponytail: single-line frontmatter values read by regex, not a YAML parser; a
// folded description (`>`, `|`) lists as its marker. Parse YAML if one appears.
const field = (frontmatter: string, key: string) =>
  new RegExp(`^${key}:[ \\t]*(.*)$`, 'm')
    .exec(frontmatter)?.[1]
    ?.trim()
    .replace(/^(["'])(.*)\1$/, '$2') ?? ''

const row = ([name, description]: [string, string]) => {
  if (description === '') {
    return `- /${name}`
  }
  const isCut = description.length > DESCRIPTION_LENGTH

  return `- /${name}: ${isCut ? `${description.slice(0, DESCRIPTION_LENGTH).trimEnd()}…` : description}`
}

/**
 * The section's text: every skill in the `/` menu that Claude is not shown,
 * or `''` when there is none.
 *
 * A skill is user-only by its own frontmatter (`disable-model-invocation`) or
 * by the person's `skillOverrides` (`user-invocable-only`); `off` leaves the
 * menu too, so it is not listed.
 */
// ponytail: personal skills (~/.claude/skills) only; add the project's
// .claude/skills and plugin skills when one of those has user-only skills.
async function listing($: EngineInterface): Promise<string> {
  const root = `${await $.env.get('HOME')}/.claude/skills`
  const overrides = ((await $.settings.read()).skillOverrides ?? {}) as Record<string, unknown>
  // A skill the settings hide may have no folder (the built-in ones): it is
  // listed by name, and its folder's description fills in when there is one.
  const skills = new Map<string, string>()
  for (const [name, mode] of Object.entries(overrides)) {
    if (mode === 'user-invocable-only') {
      skills.set(name, '')
    }
  }

  await Promise.all(
    (await $.fs.list(root)).map(async entry => {
      const text = await $.fs.read(`${root}/${entry.name}/SKILL.md`).catch(() => '')
      const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text)?.[1]
      if (frontmatter === undefined) {
        return
      }
      const name = field(frontmatter, 'name') || entry.name
      const isUserOnly =
        skills.has(name) || field(frontmatter, 'disable-model-invocation') === 'true'
      if (isUserOnly && overrides[name] !== 'off') {
        skills.set(name, field(frontmatter, 'description'))
      }
    }),
  )
  if (skills.size === 0) {
    return ''
  }
  // Sorted, so the text is the same on every load and the prompt cache holds.
  const rows = [...skills].sort(([a], [b]) => (a < b ? -1 : 1)).map(row)

  return `${INTRO}\n\n${rows.join('\n')}`
}

export const register: Register = on => {
  // Read once per load: a skill added mid-session is listed from the next one.
  let text: Promise<string> | undefined

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (e.traits.includes('bare')) {
      return composed
    }
    text ??= listing($).catch(() => '')
    const listed = await text

    return listed === ''
      ? composed
      : { sections: [...composed.sections, { id: SECTION, text: listed, scope: 'session' }] }
  })
}
