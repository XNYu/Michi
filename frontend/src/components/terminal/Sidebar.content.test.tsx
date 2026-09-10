import React, { createContext, useContext, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrefsProvider, usePrefs } from '../../state/prefs';
import Sidebar from './Sidebar';

const mocks = vi.hoisted(() => ({ renders: vi.fn(), fetchPrefs: vi.fn(), savePrefs: vi.fn() }));
vi.mock('../../services/api', () => ({ fetchPrefs: mocks.fetchPrefs, savePrefs: mocks.savePrefs }));
vi.mock('./ActivityView', () => ({ default: () => <ContentProbe /> }));
vi.mock('./WorkspaceTree', () => ({ default: () => <ContentProbe /> }));
vi.mock('./TreeSelectionBar', () => ({ default: () => null }));

const DataContext = createContext(0);
function ContentProbe() {
  const { prefs, setPref } = usePrefs();
  const data = useContext(DataContext);
  mocks.renders();
  return <button data-testid="content" onClick={() => setPref('sidebarDensity', 'airy')}>
    {prefs.sidebarView}:{prefs.sidebarDensity}:{String(prefs.sidebarCollapsed)}:{data}
  </button>;
}

const noop = () => {};
function Harness() {
  const { prefs, setPref } = usePrefs();
  const [data, setData] = useState(0);
  return <>
    <button onClick={() => setPref('sidebarCollapsed', !prefs.sidebarCollapsed)}>Toggle</button>
    <button onClick={() => setPref('terminalSidebarWidth', 360)}>Resize</button>
    <button onClick={() => setData(data + 1)}>Data</button>
    <DataContext.Provider value={data}>
      <Sidebar activePage="dashboard" onNav={noop} onOpenPalette={noop} onNewThread={noop} />
    </DataContext.Provider>
  </>;
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.fetchPrefs.mockResolvedValue(null);
});
afterEach(cleanup);

describe('sidebar content isolation', () => {
  it.each(['activity', 'structure'])('%s keeps contents mounted and skips collapse-only renders', async sidebarView => {
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ sidebarView }));
    const { container } = render(<PrefsProvider><Harness /></PrefsProvider>);
    await act(async () => { await Promise.resolve(); });
    const content = screen.getByTestId('content');
    const count = mocks.renders.mock.calls.length;
    const inner = container.querySelector<HTMLElement>('.terminal-sidebar-content')!;
    const shell = container.querySelector<HTMLElement>('aside')!;
    for (let i = 0; i < 4; i++) {
      fireEvent.click(screen.getByText('Toggle'));
      expect(shell.style.width).toBe(i % 2 === 0 ? '0px' : '280px');
      expect(inner.style.width).toBe('280px');
      expect(screen.getByTestId('content')).toBe(content);
      expect(mocks.renders).toHaveBeenCalledTimes(count);
    }
  });

  it('continues propagating content preferences, width changes, and live data while collapsed', async () => {
    render(<PrefsProvider><Harness /></PrefsProvider>);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByText('Toggle'));
    fireEvent.click(screen.getByText('Data'));
    expect(screen.getByTestId('content').textContent).toContain(':false:1');
    fireEvent.click(screen.getByTestId('content'));
    expect(screen.getByTestId('content').textContent).toContain(':airy:');
    fireEvent.click(screen.getByText('Resize'));
    expect(document.querySelector<HTMLElement>('.terminal-sidebar-content')!.style.width).toBe('360px');
    fireEvent.click(screen.getByText('Toggle'));
    expect(document.querySelector<HTMLElement>('aside')!.style.width).toBe('360px');
    expect(screen.getByTestId('content').textContent).toContain(':airy:false:1');
  });
});
