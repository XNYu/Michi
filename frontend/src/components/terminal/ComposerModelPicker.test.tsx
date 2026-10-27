import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerModelPicker, type ComposerModelPickerProps } from './ComposerModelPicker';

const baseProps: ComposerModelPickerProps = {
  anchor: { x: 100, y: 650, anchorBottom: 610 },
  agentStatus: {
    runtime: 'codex', label: 'Codex', model: 'fast', reasoning: 'medium', hasRequiredKey: true,
    availableRuntimes: [{ id: 'codex', label: 'Codex', available: true }, { id: 'claude', label: 'Claude', available: true }, { id: 'kiro', label: 'Kiro', available: false }],
    capabilities: { modes: true, permissions: true, models: true, providerModels: false, reasoning: true,
      supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh'], apiKeys: false, nativeResume: false, warmSessions: true, saveContext: true, spawnBranches: true },
  },
  resolvedBinding: { runtime: 'codex', model: 'fast', reasoning: 'medium', provider: undefined, source: 'global' },
  catalogCapabilities: null,
  providerModels: [{ id: 'fast', label: 'Fast' }, { id: 'deep', label: 'Deep', description: 'Reasoning model' }],
  modelsLoading: false, modelsError: null,
  onSwitchRuntime: vi.fn(), onSaveModel: vi.fn(), onSaveReasoning: vi.fn(), onRetryModels: vi.fn(), onClose: vi.fn(),
};

describe('ComposerModelPicker', () => {

  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('blinks once before selecting, while Back cancels a pending selection immediately', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
    vi.useFakeTimers();
    const onSaveModel = vi.fn();
    render(<ComposerModelPicker {...baseProps} onSaveModel={onSaveModel} />);
    fireEvent.click(screen.getByRole('button', { name: /Select model:/ }));
    const deep = screen.getByRole('menuitemradio', { name: /Deep/ });
    fireEvent.click(deep);
    fireEvent.click(deep);
    expect(deep.classList.contains('ui-menu-blink')).toBe(true);
    expect(onSaveModel).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(159); });
    expect(onSaveModel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Back to model settings' }));
    act(() => { vi.advanceTimersByTime(200); });
    expect(onSaveModel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Select model:/ }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Deep/ }));
    act(() => { vi.advanceTimersByTime(160); });
    expect(onSaveModel).toHaveBeenCalledExactlyOnceWith('deep');
    expect(screen.getByRole('slider')).toBeTruthy();
  });

  it('hides effort for an unset binding whose default model has none', () => {
    const onSaveReasoning = vi.fn();
    render(<ComposerModelPicker {...baseProps} onSaveReasoning={onSaveReasoning} resolvedBinding={{ ...baseProps.resolvedBinding, model: undefined }}
      providerModels={[{ id: 'auto', label: 'auto', supportsReasoning: false, supportedReasoningLevels: [] }, { id: 'deep' }]} />);
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.queryByText('Thinking effort')).toBeNull();
    expect(onSaveReasoning).not.toHaveBeenCalled();
  });

  it('supports nested Escape and restores focus to the trigger', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    const onClose = vi.fn();
    const view = render(<ComposerModelPicker {...baseProps} anchor={{ ...baseProps.anchor, trigger }} onClose={onClose} />);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(screen.getByRole('menu', { name: 'Models' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Select model: Fast' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
    view.unmount();
    trigger.remove();
  });

  it('navigates with arrows and skips unavailable runtimes', () => {
    render(<ComposerModelPicker {...baseProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Select runtime: Codex' }));
    const kiro = screen.getByRole('menuitemradio', { name: /Kiro/ });
    expect((kiro as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Claude' }));
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Claude' }));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Select runtime: Codex' }));
  });

  it('keeps the menu mounted across runtime changes without inheriting old capabilities', () => {
    const view = render(<ComposerModelPicker {...baseProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Select runtime: Codex' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Claude' }));
    view.rerender(<ComposerModelPicker {...baseProps} modelsLoading providerModels={[]}
      resolvedBinding={{ runtime: 'claude', provider: undefined, model: undefined, reasoning: undefined, source: 'pending' }} />);
    expect(screen.getByRole('button', { name: 'Select runtime: Claude' })).toBeTruthy();
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.getByText('Loading models…')).toBeTruthy();
  });

  it('searches only models by label, identifier and description with a visible empty state', () => {
    render(<ComposerModelPicker {...baseProps} providerModels={Array.from({ length: 10 }, (_, index) => ({ id: `model-${index}`, label: `Model ${index}`, description: index === 5 ? 'Vision' : undefined }))} />);
    fireEvent.click(screen.getByRole('button', { name: /Select model/ }));
    const search = screen.getByRole('searchbox', { name: 'Search models' });
    expect(document.activeElement).toBe(search);
    fireEvent.change(search, { target: { value: 'vision' } });
    expect(within(screen.getByRole('menu')).getAllByRole('menuitemradio')).toHaveLength(1);
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Model 5 Vision' }));
    fireEvent.change(search, { target: { value: 'missing' } });
    expect(screen.getByText('No matching models')).toBeTruthy();
  });

  it('commits only the final drag step and honors the advertised effort levels', () => {
    const onSaveReasoning = vi.fn();
    render(<ComposerModelPicker {...baseProps} onSaveReasoning={onSaveReasoning} />);
    const slider = screen.getByRole('slider');
    expect(slider.getAttribute('max')).toBe('3');
    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: '2' } });
    fireEvent.change(slider, { target: { value: '3' } });
    expect(onSaveReasoning).not.toHaveBeenCalled();
    fireEvent.pointerUp(slider);
    expect(onSaveReasoning).toHaveBeenCalledExactlyOnceWith('xhigh');
  });

  it('does not save a cancelled drag or reselecting the current value', () => {
    const onSaveReasoning = vi.fn();
    const onSaveModel = vi.fn();
    render(<ComposerModelPicker {...baseProps} onSaveReasoning={onSaveReasoning} onSaveModel={onSaveModel} />);
    const slider = screen.getByRole('slider');
    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: '3' } });
    fireEvent.pointerCancel(slider);
    expect(slider.getAttribute('aria-valuetext')).toBe('Medium');
    expect(onSaveReasoning).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Select model/ }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Fast' }));
    expect(onSaveModel).not.toHaveBeenCalled();
  });

  it('exposes providers separately with key-configuration status', () => {
    const onSaveProvider = vi.fn();
    render(<ComposerModelPicker {...baseProps} catalogCapabilities={{ ...baseProps.agentStatus!.capabilities, providerModels: true }}
      providers={[{ id: 'openrouter', label: 'OpenRouter', keyLabel: 'Key', envVars: [], defaultModel: 'auto', supportsReasoning: true, hasKey: false }]}
      onSaveProvider={onSaveProvider} />);
    fireEvent.click(screen.getByRole('button', { name: /Select provider/ }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /OpenRouter No API key configured/ }));
    expect(onSaveProvider).toHaveBeenCalledExactlyOnceWith('openrouter');
  });

  it('dismisses for an outside pointer but leaves trigger toggling to the trigger', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    const onClose = vi.fn();
    const view = render(<ComposerModelPicker {...baseProps} anchor={{ ...baseProps.anchor, trigger }} onClose={onClose} />);
    fireEvent.pointerDown(trigger);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount(); trigger.remove();
  });
});

describe('ComposerModelPicker placement', () => {
  const layout = { content: 230, chrome: 30 };
  const size = (element: HTMLElement) => element.classList.contains('composer-picker-content') ? layout.content
    : element.classList.contains('composer-picker') ? layout.content + layout.chrome : 0;
  const triggerAt = (top: number) => {
    const trigger = document.createElement('button');
    trigger.getBoundingClientRect = () => ({ top, bottom: top + 30, left: 200, right: 290, width: 90, height: 30, x: 200, y: top, toJSON: () => ({}) });
    document.body.append(trigger);
    triggers.push(trigger);
    return trigger;
  };
  const triggers: HTMLElement[] = [];
  const surfaceTop = () => parseFloat(screen.getByRole('dialog', { name: 'Model settings' }).style.top);

  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    vi.stubGlobal('innerHeight', 844);
    vi.stubGlobal('innerWidth', 390);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return size(this); });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return size(this); });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const height = this instanceof HTMLElement ? size(this) : 0;
      const top = this instanceof HTMLElement && this.classList.contains('composer-picker-content') ? layout.chrome : 0;
      return { top, bottom: top + height, left: 0, right: 280, width: 280, height, x: 0, y: top, toJSON: () => ({}) };
    });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); layout.content = 230; triggers.splice(0).forEach((trigger) => trigger.remove()); });

  it('opens below the trigger when the summary does not fit above but fits below', () => {
    const trigger = triggerAt(270);
    render(<ComposerModelPicker {...baseProps} anchor={{ ...baseProps.anchor, trigger }} />);
    // 256 px above the trigger, 260 px wanted: below, 6 px under its bottom edge.
    expect(surfaceTop()).toBe(306);
  });

  it('still opens above when the summary fits there', () => {
    layout.content = 150;
    const trigger = triggerAt(270);
    render(<ComposerModelPicker {...baseProps} anchor={{ ...baseProps.anchor, trigger }} />);
    expect(surfaceTop()).toBe(264 - 180);
  });

  it('opens above a composer near the bottom of the window', () => {
    const trigger = triggerAt(700);
    render(<ComposerModelPicker {...baseProps} anchor={{ ...baseProps.anchor, trigger }} />);
    expect(surfaceTop()).toBe(694 - 260);
  });

  it('keeps the side it opened on while moving to a sub-page', () => {
    const trigger = triggerAt(270);
    render(<ComposerModelPicker {...baseProps} anchor={{ ...baseProps.anchor, trigger }} />);
    expect(surfaceTop()).toBe(306);
    layout.content = 100;
    fireEvent.click(screen.getByRole('button', { name: 'Select runtime: Codex' }));
    expect(screen.getByRole('menu', { name: 'Runtimes' })).toBeTruthy();
    expect(surfaceTop()).toBe(306);
  });
});
