/** What the person unfolded under one run's summary. */
export type Unfolded = {
  /** The passing tests, listed under the failures. */
  isPassedShown?: boolean
  /** The run's whole output, as the engine draws it. */
  isOutputShown?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    /** By the run's tool_use_id. */
    'test-summary': { unfolded: Record<string, Unfolded> }
  }
}
