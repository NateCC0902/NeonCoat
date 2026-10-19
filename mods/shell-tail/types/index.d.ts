/** A shell command Claude started that is still running. */
export type Shell = {
  /** The command as Claude wrote it. */
  command: string
  /** The file Claude Code writes its output to as it runs. */
  file: string
  /** The call it runs under; absent once it runs in the background. */
  toolUseId?: string
  isBackground: boolean
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
