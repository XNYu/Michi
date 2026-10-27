import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MetaAgentGuardStatus } from 'michi-shared';
import { MetaAgentGuardAlert } from './MetaAgentGuardAlert';
import { useZhCnDefaultLocale } from '../../../../test/zhCnLocale';

const failure: MetaAgentGuardStatus = {
  state: 'failed', runtimeId: 'kiro', toolset: 'maintenance', unexpectedTools: ['execute_bash'],
  checkedAt: new Date(2026, 9, 23, 9, 41).getTime(),
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('MetaAgentGuardAlert', () => {
  it('writes when the check ran in English on a Chinese browser', () => {
    useZhCnDefaultLocale();
    render(<MetaAgentGuardAlert failures={[failure]} onRetry={vi.fn()} onChangeRuntime={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    const details = screen.getByRole('alert').querySelector('dl')!;
    expect(details.textContent).toContain('Kiro · checked Oct 23, 09:41');
    expect(details.textContent).not.toMatch(/[年月日]/);
  });
});
