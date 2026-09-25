import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerModelPicker, type ComposerModelPickerProps } from './ComposerModelPicker';

const baseProps: ComposerModelPickerProps = {
  anchor: { x: 100, y: 650, anchorBottom: 610 },
  agentStatus: {
    runtime: 'codex', label: 'Codex', model: 'fast', reasoning: 'medium', hasRequiredKey: true,
    availableRuntimes: [{ id: 'codex', label: 'Codex', available: true }, { id: 'claude', label: 'Claude', available: true }, { id: 'kiro', label: 'Kiro', available: false }],
    capabilities: { modes: true, permissions: true, models: true, providerModels: false, reasoning: true,
      supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh'], apiKeys: false, warmSessions: true, saveContext: true, spawnBranches: true },
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

  it('updates effort when the selected model changes and hides fixed or unsupported effort', () => {
    const view = render(<ComposerModelPicker {...baseProps} />);
    const binding = { ...baseProps.resolvedBinding, reasoning: 'max' as const };
    view.rerender(<ComposerModelPicker {...baseProps} resolvedBinding={binding}
      providerModels={[{ id: 'fast', supportedReasoningLevels: ['low', 'medium', 'high'], defaultReasoning: 'high' }]} />);
    const slider = screen.getByRole('slider');
    expect(slider.getAttribute('max')).toBe('2');
    expect(slider.getAttribute('aria-valuetext')).toBe('High');
    view.rerender(<ComposerModelPicker {...baseProps} resolvedBinding={binding}
      providerModels={[{ id: 'fast', supportedReasoningLevels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] }]} />);
    expect(screen.getByRole('slider').getAttribute('max')).toBe('5');
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBe('Max');
    screen.getByRole('slider').focus();
    view.rerender(<ComposerModelPicker {...baseProps} providerModels={[{ id: 'fast', supportedReasoningLevels: ['high'] }]} />);
    expect(screen.queryByText('Thinking effort')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Select runtime: Codex' }));
    view.rerender(<ComposerModelPicker {...baseProps} providerModels={[{ id: 'fast', supportsReasoning: false }]} />);
    expect(screen.queryByRole('slider')).toBeNull();
  });

  it('places runtime above model and follows that order with keyboard navigation', () => {
    render(<ComposerModelPicker {...baseProps} />);
    const runtime = screen.getByRole('button', { name: 'Select runtime: Codex' });
    const model = screen.getByRole('button', { name: 'Select model: Fast' });
    expect(within(screen.getByRole('dialog')).getAllByRole('button')).toEqual([runtime, model]);
    expect(document.activeElement).toBe(runtime);
    fireEvent.keyDown(runtime, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(model);
    fireEvent.keyDown(model, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('slider', { name: 'Thinking effort' }));
  });

  it('places the Pi provider between runtime and model, including keyboard navigation', () => {
    render(<ComposerModelPicker {...baseProps}
      resolvedBinding={{ ...baseProps.resolvedBinding, runtime: 'pi', provider: 'openrouter' }}
      catalogCapabilities={{ ...baseProps.agentStatus!.capabilities, providerModels: true }}
      providers={[{ id: 'openrouter', label: 'OpenRouter', keyLabel: 'Key', envVars: [], defaultModel: 'fast', supportsReasoning: true }]}
      onSaveProvider={vi.fn()} />);
    const buttons = within(screen.getByRole('dialog')).getAllByRole('button');
    expect(buttons.map((button) => button.getAttribute('data-picker-page'))).toEqual(['runtime', 'provider', 'model']);
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(buttons[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(buttons[1]);
    fireEvent.keyDown(buttons[1], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(buttons[2]);
  });

  it.each(['', 'Model 9', 'no match'])('returns from model search %j and clears the search on reentry', (query) => {
    const onClose = vi.fn();
    const onSaveModel = vi.fn();
    render(<ComposerModelPicker {...baseProps} onClose={onClose} onSaveModel={onSaveModel}
      providerModels={Array.from({ length: 10 }, (_, index) => ({ id: `model-${index}`, label: `Model ${index}` }))} />);
    fireEvent.click(screen.getByRole('button', { name: /Select model:/ }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: query } });
    fireEvent.click(screen.getByRole('button', { name: 'Back to model settings' }));
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Select model:/ }));
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaveModel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Select model:/ }));
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('');
    expect(document.activeElement).toBe(screen.getByRole('searchbox'));
  });

  it('starts compact, reveals one list at a time and applies a model without a delayed close', () => {
    const onSaveModel = vi.fn();
    const onClose = vi.fn();
    render(<ComposerModelPicker {...baseProps} onSaveModel={onSaveModel} onClose={onClose} />);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('slider', { name: 'Thinking effort' }).getAttribute('aria-valuetext')).toBe('Medium');
    fireEvent.click(screen.getByRole('button', { name: 'Select model: Fast' }));
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.getByRole('menuitemradio', { name: 'Fast' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Deep/ }));
    expect(onSaveModel).toHaveBeenCalledExactlyOnceWith('deep');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('slider')).toBeTruthy();
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

  it('keeps errors visible, prevents duplicate saves, and allows a retry', async () => {
    let reject!: (error: Error) => void;
    const onSaveModel = vi.fn().mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; })).mockResolvedValue(undefined);
    render(<ComposerModelPicker {...baseProps} onSaveModel={onSaveModel} />);
    fireEvent.click(screen.getByRole('button', { name: /Select model/ }));
    const deep = screen.getByRole('menuitemradio', { name: /Deep/ });
    fireEvent.click(deep);
    fireEvent.click(deep);
    expect(onSaveModel).toHaveBeenCalledTimes(1);
    expect((deep as HTMLButtonElement).disabled).toBe(true);
    await act(async () => reject(new Error('Could not save model')));
    expect(screen.getByRole('alert').textContent).toBe('Could not save model');
    fireEvent.click(deep);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(onSaveModel).toHaveBeenCalledTimes(2);
  });

  it('shows current models during a failed catalog fetch and retries without dismissal', () => {
    const onRetryModels = vi.fn();
    const onClose = vi.fn();
    render(<ComposerModelPicker {...baseProps} providerModels={[]} modelsError="Catalog unavailable" onRetryModels={onRetryModels} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /Select model/ }));
    expect(screen.getByRole('menuitemradio', { name: /fast Current model/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetryModels).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
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
