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
 * The list's rows: every skill in the `/` menu that Claude is not shown, or
 * `''` when there is none.
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

  return rows.join('\n')
}

const ROUTE = `You route a Claude Code user to one of their skills. Each skill listed below is a slash command that only the user can run. Answer the user's question by naming the one or two skills that fit, the best fit first, each on a line of its own as "/name: why it fits". If none fits, say so in one line. Write nothing else.`

// Read once per load: a skill added mid-session is listed from the next one.
let rows: Promise<string> | undefined
let reported = ''

/** The list's rows; `''`, its reason shown once, when reading them failed. */
function list($: EngineInterface) {
  return (rows ??= listing($)).catch((error: unknown) => {
    // A failed read is not kept: the next prompt tries again. Its reason is
    // shown once, so a section that went missing does not go unnoticed.
    rows = undefined
    const reason = String(error)
    if (reason !== reported) {
      reported = reason
      $.ui.log(`${$.plugin.name}: no skills are listed, reading them failed: ${reason}`)
    }

    return ''
  })
}

export const register: Register = (on, options) => {
  if (options.enabled === false) {
    return
  }
  rows = undefined
  reported = ''

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const listed = e.traits.includes('bare') ? '' : await list($)

    return listed === ''
      ? composed
      : {
          sections: [
            ...composed.sections,
            { id: SECTION, text: `${INTRO}\n\n${listed}`, scope: 'session' },
          ],
        }
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'skill-router',
      description: 'Ask which of your user-only skills fits a situation',
      argumentHint: '<question>',
    })

    return next(e)
  })

  // A small model answers aside, at once and without a turn of the session.
  // ponytail: it reads the question alone, not the conversation; hand it the
  // last messages too if its answers miss what the session is about.
  on('command.run', { command: 'skill-router' }, async ($, e) => {
    const listed = await list($)
    const question = e.args.trim()
    if (listed === '') {
      return { text: 'No skill here is one only you can run.' }
    }
    if (question === '') {
      return { text: listed }
    }

    const reply = await $.model.complete({
      model: 'haiku',
      system: `${ROUTE}\n\n${listed}`,
      prompt: question,
      effort: 'low',
      maxTokens: 300,
    })

    return { text: reply.isAnswered ? reply.text : `No answer from the model: ${reply.reason}.` }
  })
}
