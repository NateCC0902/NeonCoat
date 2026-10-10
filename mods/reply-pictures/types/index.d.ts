/** A rendered picture: the PNG's absolute path and its size in CSS px. */
export type Diagram = { file: string; width: number; height: number }

declare module 'claude-code' {
  interface PluginState {
    /** By the block as written (a fence, a `$$` formula, an image line); `null` is one that did not render. */
    'reply-pictures': {
      diagrams: Record<string, Diagram | null>
      /** The block whose picture the zoom pane shows; `null` before any was zoomed. */
      zoomed: string | null
    }
  }
}
