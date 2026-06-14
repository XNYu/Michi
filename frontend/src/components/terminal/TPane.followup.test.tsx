import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { FollowUpRow } from '../FollowUpRow';

describe('FollowUpRow wired with TPane-style handlers', () => {
  it('text click invokes the sendMessage-shaped callback only', () => {
    const sendMessage = vi.fn();
    const createChildChat = vi.fn();
    const NODE_ID = 'node-1';
    const Q = 'follow up text';
    render(
      <FollowUpRow
        index={0}
        question={Q}
        onContinue={(q) => sendMessage(NODE_ID, q)}
        onBranch={(q) => createChildChat(NODE_ID, q)}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Continue follow-up 1/i }));
    expect(sendMessage).toHaveBeenCalledWith(NODE_ID, Q);
    expect(createChildChat).not.toHaveBeenCalled();
  });

  it('branch button click invokes the createChildChat-shaped callback only', () => {
    const sendMessage = vi.fn();
    const createChildChat = vi.fn();
    const NODE_ID = 'node-1';
    const Q = 'follow up text';
    render(
      <FollowUpRow
        index={2}
        question={Q}
        onContinue={(q) => sendMessage(NODE_ID, q)}
        onBranch={(q) => createChildChat(NODE_ID, q)}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Branch follow-up 3/i }));
    expect(createChildChat).toHaveBeenCalledWith(NODE_ID, Q);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
