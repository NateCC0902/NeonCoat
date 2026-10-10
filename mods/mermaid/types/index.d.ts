/** A rendered diagram: the PNG's absolute path and its size in CSS px. */
export type Diagram = { file: string; width: number; height: number }

declare module 'claude-code' {
  interface PluginState {
    /** By mermaid source; `null` is a source that did not render. */
    mermaid: { diagrams: Record<string, Diagram | null> }
  }
}
