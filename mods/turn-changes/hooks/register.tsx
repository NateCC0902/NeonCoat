import { atom, read, update } from 'claude-code'
import type { BuiltinToolResults, EngineInterface, Register, ToolCallResult } from 'claude-code'

import type { FileChange, Hunk } from '../types'

const turn = atom({ plugin: 'turn-changes', key: 'turn' } as const, null)
const changes = atom({ plugin: 'turn-changes', key: 'changes' } as const, { turnId: null, files: [] as FileChange[] })
const open = atom({ plugin: 'turn-changes', key: 'open' } as const, null)
const isDismissed = atom({ plugin: 'turn-changes', key: 'isDismissed' } as const, false)

const PANE = 'turn-changes'
const TITLE = 'Turn changes'

type Written = BuiltinToolResults['Edit'] | BuiltinToolResults['Write']

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
const count = (hunks: Hunk[], mark: string) =>
  hunks.reduce((sum, hunk) => sum + hunk.lines.filter(line => line.startsWith(mark)).length, 0)

/** An edit's hunks; a new file reports none, so its whole content is one. */
const hunksOf = (result: Written): Hunk[] => {
  if (result.structuredPatch.length > 0) {
    return result.structuredPatch.map(hunk => ({ ...hunk, lines: [...hunk.lines] }))
  }
  if ('type' in result && result.type === 'create' && result.content !== '') {
    const lines = result.content.replace(/\n$/, '').split('\n')

    return [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map(line => `+${line}`) }]
  }

  return []
}

/** Hunks as the unified diff a `Code` draws under `format: 'diff'`. */
const unified = (hunks: Hunk[]) =>
  hunks.map(hunk => [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines].join('\n')).join('\n')

/** Adds an edit that went through to the turn's files, and opens the pane at the turn's first. */
async function record($: EngineInterface, ran: ToolCallResult) {
  const result = ran.result as Written | undefined
  if (ran.deny !== undefined || ran.isError === true || result === undefined) {
    return
  }
  const hunks = hunksOf(result)
  if (hunks.length === 0) {
    return
  }
  const root = await $.session.root()
  const path = result.filePath.startsWith(`${root}/`) ? result.filePath.slice(root.length + 1) : result.filePath
  const isNew = 'type' in result && result.type === 'create'
  const turnId = await read($, turn)
  let isFirst = false

  await update($, changes, current => {
    const files = current.turnId === turnId ? current.files : []
    isFirst = files.length === 0
    const known = files.find(file => file.path === path)
    const file: FileChange = {
      path,
      isNew: known?.isNew ?? isNew,
      added: (known?.added ?? 0) + count(hunks, '+'),
      removed: (known?.removed ?? 0) + count(hunks, '-'),
      edits: [...(known?.edits ?? []), hunks],
    }

    return { turnId, files: known ? files.map(each => (each === known ? file : each)) : [...files, file] }
  })
  if (isFirst) {
    await update($, open, () => null)
    // Unasked, a pane is placed only where the terminal is wide enough for a sidebar.
    if (!(await read($, isDismissed))) {
      void $.ui.open({ id: PANE, title: TITLE })
    }
  }
}

export const register: Register = (on, options) => {
  if (options.enabled === false) {
    return
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'changes', description: 'Show the files the last turn changed, each with its diff, in a pane' })

    return next(e)
  })

  on('command.run', { command: 'changes' }, async $ => {
    await update($, isDismissed, () => false)
    const opened = await $.ui.open({ id: PANE, title: TITLE })

    return { text: opened.isPlaced ? 'Opened the turn changes pane.' : `The turn changes pane is not shown: ${opened.reason}.` }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') {
      await update($, isDismissed, () => true)
    }

    return next(e)
  })

  // The main loop's turns only: a subagent's edits count toward the turn that started it.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, turn, () => e.turnId)
    }

    return next(e)
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    await record($, ran)

    return ran
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    await record($, ran)

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const { files } = await read($, changes)
    const openPath = await read($, open)
    const shown = files.find(file => file.path === openPath)
    const totals = (added: number, removed: number) => (
      <Box flexDirection="row" columnGap={1}>
        <Text color="success">+{added}</Text>
        <Text color="error">−{removed}</Text>
      </Box>
    )

    if (files.length === 0) {
      return <Text color="subtle">No file changed yet. A turn's edits show here as it makes them.</Text>
    }

    if (shown === undefined) {
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Text color="subtle">{plural(files.length, 'file')}</Text>
            {totals(
              files.reduce((sum, file) => sum + file.added, 0),
              files.reduce((sum, file) => sum + file.removed, 0),
            )}
          </Box>
          {files.map(file => {
            const at = file.path.lastIndexOf('/') + 1

            return (
              <Button key={`file:${file.path}`} plain onPress={() => update($, open, () => file.path)}>
                <Text color={file.isNew ? 'success' : 'claude'}>{file.isNew ? 'A ' : 'M '}</Text>
                <Text color="subtle">{file.path.slice(0, at)}</Text>
                {file.path.slice(at)}
                <Text color="success"> +{file.added}</Text>
                <Text color="error"> −{file.removed}</Text>
              </Button>
            )
          })}
          <Text color="subtle">Press a file to see what the turn changed in it.</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={2}>
          <Button key="back" plain label="← files" onPress={() => update($, open, () => null)} />
          <Text bold>{shown.path}</Text>
          {totals(shown.added, shown.removed)}
        </Box>
        {shown.edits.map((hunks, index) => (
          <Box flexDirection="column" marginTop={1}>
            {shown.edits.length > 1 && <Text color="subtle">edit {index + 1} of {shown.edits.length}</Text>}
            <Code format="diff" path={shown.path} source={unified(hunks)} wrap="truncate-end" />
          </Box>
        ))}
      </Box>
    )
  })
}
