/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_MARKDOWN_RENDERER?: 'react-markdown' | 'streamdown';
  readonly VITE_MICHI_METRICS?: string;
  readonly VITE_MICHI_METRICS_RUN_ID?: string;
  readonly VITE_MICHI_PERF?: string;
  readonly VITE_MICHI_STARTUP_TRACE?: string;
  readonly VITE_MICHI_STARTUP_RUN_ID?: string;
  readonly VITE_MICHI_FRAME_METRICS?: string;
  readonly VITE_MICHI_FRAME_METRICS_WINDOW_MS?: string;
  readonly VITE_STREAMING_MARKDOWN_BLOCKS?: string;
  /** When '1' / 'true', mount the design-system Profile page (sidebar
   *  entry, ⌘P shortcut, command-palette command). Default off. */
  readonly VITE_MICHI_PROFILE_PAGE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
