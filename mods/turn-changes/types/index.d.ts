/** One hunk of an edit, as Edit and Write report it: its lines led by ' ', '+' or '-'. */
export type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }

/** A file the turn changed: every edit it made there, in order. */
export type FileChange = {
  /** Relative to the session's project root when under it, else absolute. */
  path: string
  isNew: boolean
  added: number
  removed: number
  edits: Hunk[][]
}

declare module 'claude-code' {
  interface PluginState {
    'turn-changes': {
      /** The main loop's turn now running, or last run. */
      turn: string | null
      /** The changes of the last turn that changed a file. */
      changes: { turnId: string | null; files: FileChange[] }
      /** The file whose diff the pane shows; null for the list. */
      open: string | null
      /** The person closed the pane: it opens again only by /changes. */
      isDismissed: boolean
    }
  }
}
