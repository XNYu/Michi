import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './fonts.css';
import { startFrameMetrics } from './services/frameMetrics';
import { startupMark } from './services/startupTrace';

startupMark('renderer_script_start', {
  href: typeof window !== 'undefined' ? window.location.href : undefined,
});

// --- P2: Global error capture ---
// Catch uncaught errors and unhandled rejections that escape React's
// ErrorBoundary (event handlers, async callbacks, third-party code).
// These are logged, not displayed — the ErrorBoundary handles UI recovery.
// De-duplicate by error message to avoid flooding the console during loops.
const _reportedErrors = new Set<string>();
function reportGlobalError(source: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const key = `${source}:${message}`;
  if (_reportedErrors.has(key)) return;
  _reportedErrors.add(key);
  // eslint-disable-next-line no-console
  console.error(`[GlobalErrorCapture:${source}]`, error);
}
window.addEventListener('error', (event) => {
  reportGlobalError('window.onerror', event.error ?? event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  reportGlobalError('unhandledrejection', event.reason);
});

// Set <html lang> so CSS :lang() selectors pick the right CJK font stack.
const navLang = navigator.language.toLowerCase();
document.documentElement.lang =
  navLang.startsWith('ja') ? 'ja'
  : navLang.startsWith('ko') ? 'ko'
  : navLang.startsWith('zh') ? 'zh'
  : 'en';

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);

startupMark('react_render_start');
const specimen = import.meta.env.DEV
  ? new URLSearchParams(window.location.search).get('specimen')
  : null;
if (specimen === 'agent-blocks') {
  // Dev-only specimen sheet for visual verification of the agent-block
  // variants — bypasses the app shell entirely.
  void import('./components/terminal/AgentBlocksSpecimen').then(({ default: AgentBlocksSpecimen }) => {
    root.render(<AgentBlocksSpecimen />);
  });
} else {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
startupMark('react_render_scheduled');

const stopFrameMetrics = startFrameMetrics();
if (import.meta.hot && stopFrameMetrics) {
  import.meta.hot.dispose(stopFrameMetrics);
}
