import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './fonts.css';
import { startFrameMetrics } from './services/frameMetrics';
import { startupMark } from './services/startupTrace';

startupMark('renderer_script_start', {
  href: typeof window !== 'undefined' ? window.location.href : undefined,
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
