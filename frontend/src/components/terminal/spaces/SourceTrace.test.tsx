import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SourceTrace } from './SourceTrace';

describe('SourceTrace', () => {
  it('keeps maintenance execution separate and marks an unavailable evidence message', async () => {
    const onOpenSource = vi.fn().mockResolvedValue(false);
    render(<SourceTrace source={{
      kind: 'maintenance', jobId: 'job-1', runId: 'run-1', nodeId: 'maintainer', turnId: 't-run', assistantId: 'a-run',
      evidence: [{ nodeId: 'source-node', turnId: 't-source', assistantId: 'a-source' }],
    }} onOpenSource={onOpenSource} />);
    expect(screen.getByText('Maintenance run')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Source · Open exact message' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Source unavailable'));
    expect(onOpenSource).toHaveBeenCalledWith({ kind: 'chat', nodeId: 'source-node', turnId: 't-source', assistantId: 'a-source' });
    fireEvent.click(screen.getByRole('button', { name: 'Open maintenance run' }));
    await waitFor(() => expect(screen.getByText('Run unavailable')).toBeTruthy());
    expect(onOpenSource).toHaveBeenLastCalledWith({ kind: 'chat', nodeId: 'maintainer', turnId: 't-run', assistantId: 'a-run' });
  });
});
