/** A shell command, Claude's or the person's (`!`), that is still running in the background. */
export type Shell = {
  /** The command as Claude or the person wrote it. */
  command: string
  /** What the command does, in the words of its call; the band's name for it. */
  description?: string
  /** The file Claude Code writes its output to as it runs. */
  file: string
  /** When its call started, which is before ctrl+b moved it to the background. */
  startedAt: number
  /** How long it has run, in whole seconds' worth of milliseconds. */
  elapsedMs: number
  /** Its last line, colors and progress redraws gone. */
  lastLine: string
  /** How many lines it has written; null once the file is past one read. */
  lineCount: number | null
  /** The file's size when last read; -1 before the first read. */
  size: number
}

declare module 'claude-code' {
  interface PluginState {
    'shell-tail': { shells: Record<string, Shell> }
  }
}
