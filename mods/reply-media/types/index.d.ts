/** What a played video was cut into: `count` PNG frames in `dir`, `fps` of them to the second. */
export type Frames = { dir: string; count: number; fps: number }

/**
 * A rendered picture: the PNG's absolute path and its size in CSS px. An
 * image's has the absolute path of the file it was drawn from. A video's is its
 * first frame, with the clip's own absolute path, and its frames once it was
 * played.
 */
export type Diagram = {
  file: string
  width: number
  height: number
  path?: string
  clip?: string
  frames?: Frames
}

/** Why a block has no picture: the reason its renderer script gave. */
export type Failure = { error: string }

declare module 'claude-code' {
  interface PluginState {
    /** By the block as written (a fence, a `$$` formula, an image line); a `Failure` is one that did not render. */
    'reply-media': {
      diagrams: Record<string, Diagram | Failure>
      /** The block whose picture the zoom pane shows; `null` before any was zoomed. */
      zoomed: string | null
      /** The block of the video that is playing; `null` when none is. */
      playing: string | null
    }
  }
}
