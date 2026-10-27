import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeSessionOwner } from '../src/contract/types';
import type { PermissionDecisionRequest, PermissionPolicyPort } from '../src/contract/host';
import * as root from '../src';
import { ApprovalCoordinator, approvalCoversTool, chatApprovalOptions } from '../src/core/approvals';
import { headless, interactive } from './owners';

const chat = interactive('a');
const otherChat = interactive('b');
const run = headless('attempt');

/** A host port that records its calls. The chat's owner user is `chatOwner` unless one is passed. */
function port(options: { decision?: 'allow' | 'ask' | 'deny'; chatOwner?: string | null; resetToken?: false | (() => string) } = {}) {
  const decided: PermissionDecisionRequest[] = [];
  const granted: Array<{ owner: RuntimeSessionOwner; ownerUserId?: string | null; toolName: string }> = [];
  const tokenReads: RuntimeSessionOwner[] = [];
  const tokens: Record<string, string> = {};
  const permissions: PermissionPolicyPort = {
    mode: () => 'ask',
    resolveOwnerUserId: (owner, ownerUserId) => ownerUserId || owner.mode !== 'interactive' ? ownerUserId : options.chatOwner ?? null,
    decide: (request) => { decided.push(request); return options.decision ?? 'ask'; },
    grant: (request) => { granted.push(request); },
    ...(options.resetToken === false ? {} : {
      resetToken: (owner: RuntimeSessionOwner) => {
        tokenReads.push(owner);
        if (options.resetToken) return options.resetToken();
        return owner.mode === 'interactive' ? tokens[owner.key] ?? '0' : 'run-token';
      },
    }),
  };
  return { permissions, decided, granted, tokenReads, tokens };
}

describe('ApprovalCoordinator', () => {
  it('the package root exports it', () => {
    assert.equal(root.ApprovalCoordinator, ApprovalCoordinator);
    assert.equal(root.approvalCoversTool, approvalCoversTool);
    assert.equal(root.chatApprovalOptions, chatApprovalOptions);
  });

  it('without session trust, policy is the host decision for the exact request', () => {
    const host = port({ decision: 'deny' });
    const approvals = new ApprovalCoordinator({ permissions: host.permissions });
    assert.equal(approvals.policy(chat, 'u1', 'Bash', true, 'trust'), 'deny');
    assert.equal(approvals.policy(run, null, 'read', false), 'deny');
    assert.deepEqual(host.decided, [
      { owner: chat, ownerUserId: 'u1', toolName: 'Bash', nativeRequest: true, mode: 'trust' },
      { owner: run, ownerUserId: null, toolName: 'read', nativeRequest: false, mode: undefined },
    ]);
  });

  it('session trust allows every tool despite Ask, is transient, and resets on explicit permission updates', () => {
    const host = port();
    const approvals = new ApprovalCoordinator({ permissions: host.permissions });
    assert.equal(approvals.accept('allow_session', chat, 'Bash'), true);
    assert.equal(approvals.policy(chat, null, 'edit', true, 'ask'), 'allow');
    assert.equal(approvals.policy(chat, null, 'mcp__unknown__mutate', true, 'ask'), 'allow');
    assert.equal(host.decided.length, 0);
    assert.equal(host.granted.length, 0, 'trust for all tools is not persisted');
    assert.equal(new ApprovalCoordinator({ permissions: host.permissions }).policy(chat, null, 'edit', true), 'ask',
      'a recreated session loses trust');
    host.tokens.a = '1';
    assert.equal(approvals.policy(chat, null, 'edit', true), 'ask');
    assert.equal(approvals.policy(chat, null, 'edit', true), 'ask', 'revoked trust does not return');
  });

  it('session trust cannot move to another chat, another owner user or a headless owner', () => {
    const host = port({ chatOwner: 'alice' });
    const approvals = new ApprovalCoordinator({ permissions: host.permissions });
    approvals.accept('allow_session', chat, undefined);
    assert.equal(approvals.policy(otherChat, null, 'edit', true), 'ask', 'owner rebinding cannot inherit session trust');
    assert.equal(approvals.policy(chat, null, 'edit', true), 'ask');

    approvals.accept('allow_session', chat, undefined);
    assert.equal(approvals.policy(chat, 'alice', 'edit', true), 'allow', 'the chat owner resolved explicitly or from the host');
    assert.equal(approvals.policy(chat, 'bob', 'edit', true), 'ask', 'session trust cannot cross authenticated owners');

    approvals.accept('allow_session', chat, undefined, 'alice');
    assert.equal(approvals.policy(run, 'alice', 'edit', true), 'ask');
    assert.equal(approvals.policy(chat, 'alice', 'edit', true), 'ask', 'checking a headless owner cleared the trust');
  });

  it('headless owners cannot acquire session trust or grants; only allow_once approves', () => {
    const host = port();
    const approvals = new ApprovalCoordinator({ permissions: host.permissions });
    assert.equal(approvals.accept('allow_once', run, 'Bash'), true);
    assert.equal(approvals.accept('allow_session', run, 'Bash'), false);
    assert.equal(approvals.accept('allow_always', run, 'Bash'), false);
    assert.equal(approvals.accept('reject_once', run, 'Bash'), false);
    assert.equal(approvals.accept(null, run, 'Bash'), false);
    assert.equal(approvals.policy(run, null, 'Bash', true), 'ask');
    assert.equal(host.granted.length, 0);
    assert.deepEqual(host.tokenReads, [], 'a headless owner has no reset token');
  });

  it('allow_always grants only with a tool name, through the host, with the raw name and owner user', () => {
    const host = port();
    const approvals = new ApprovalCoordinator({ permissions: host.permissions, canonicalize: (name) => name.toLowerCase() });
    assert.equal(approvals.accept('allow_always', chat, undefined), false);
    assert.equal(approvals.accept('allow_always', chat, ''), false);
    assert.equal(approvals.accept('allow_always', chat, 'Bash'), true);
    assert.equal(approvals.accept('allow_always', chat, 'Edit', 'u1'), true);
    assert.deepEqual(host.granted, [
      { owner: chat, toolName: 'Bash', ownerUserId: undefined },
      { owner: chat, toolName: 'Edit', ownerUserId: 'u1' },
    ]);
    assert.equal(approvals.policy(chat, null, 'Bash', true), 'ask', 'a grant is the host decision, not session trust');
  });

  it('other answers approve nothing', () => {
    const host = port();
    const approvals = new ApprovalCoordinator({ permissions: host.permissions });
    for (const answer of ['reject_once', 'deny', 'michi:allow_always', null]) assert.equal(approvals.accept(answer, chat, 'Bash'), false, String(answer));
    assert.equal(host.granted.length, 0);
    assert.equal(approvals.policy(chat, null, 'Bash', true), 'ask');
  });

  it('a reset token that throws counts as none', () => {
    let fail = true;
    const host = port({ resetToken: () => { if (fail) throw new Error('store unavailable'); return '0'; } });
    const approvals = new ApprovalCoordinator({ permissions: host.permissions });
    approvals.accept('allow_session', chat, undefined);
    assert.equal(approvals.policy(chat, null, 'edit', true), 'allow');
    fail = false;
    assert.equal(approvals.policy(chat, null, 'edit', true), 'ask', 'a readable token differs from none');
  });

  it('a reset token that starts throwing reads as the same missing token', () => {
    let token: () => string | undefined = () => undefined;
    const host = port();
    const approvals = new ApprovalCoordinator({ permissions: { ...host.permissions, resetToken: () => token() } });
    approvals.accept('allow_session', chat, undefined);
    token = () => { throw new Error('store unavailable'); };
    assert.equal(approvals.policy(chat, null, 'edit', true), 'allow', 'a throw is undefined, not some other token');
    token = () => '1';
    assert.equal(approvals.policy(chat, null, 'edit', true), 'ask');
  });

  it('a host without reset tokens keeps session trust for the session', () => {
    const host = port({ resetToken: false });
    const approvals = new ApprovalCoordinator({ permissions: host.permissions });
    approvals.accept('allow_session', chat, undefined);
    assert.equal(approvals.policy(chat, null, 'edit', true), 'allow');
  });

  it('covers() uses the injected canonical names', () => {
    const host = port();
    const plain = new ApprovalCoordinator({ permissions: host.permissions });
    const aliased = new ApprovalCoordinator({ permissions: host.permissions, canonicalize: (name) => ({ Bash: 'bash' }[name] ?? name) });
    assert.equal(plain.covers('allow_always', 'Bash', 'bash'), false);
    assert.equal(aliased.covers('allow_always', 'Bash', 'bash'), true);
    assert.equal(aliased.covers('allow_always', 'Bash', 'edit'), false);
    assert.equal(aliased.covers('allow_session', 'Bash', 'edit'), true);
  });
});

describe('approvalCoversTool', () => {
  it('session trust covers every request, even unnamed ones', () => {
    assert.equal(approvalCoversTool('allow_session'), true);
    assert.equal(approvalCoversTool('allow_session', 'bash', 'edit'), true);
  });

  it('an always-allow grant covers only the same canonical tool', () => {
    assert.equal(approvalCoversTool('allow_always', 'bash', 'bash'), true);
    assert.equal(approvalCoversTool('allow_always', 'bash', 'edit'), false);
    assert.equal(approvalCoversTool('allow_always', 'Bash', 'bash'), false, 'by default names must be identical');
    assert.equal(approvalCoversTool('allow_always', 'Bash', 'bash', (name) => name.toLowerCase()), true);
    assert.equal(approvalCoversTool('allow_always', undefined, 'bash'), false);
    assert.equal(approvalCoversTool('allow_always', 'bash', undefined), false);
    assert.equal(approvalCoversTool('allow_always', '', ''), false);
  });

  it('single-use answers cover nothing else', () => {
    for (const choice of ['allow_once', 'reject_once', null]) assert.equal(approvalCoversTool(choice, 'bash', 'bash'), false, String(choice));
  });
});

describe('chatApprovalOptions', () => {
  it('offers the four chat options; always-allow needs a tool name', () => {
    assert.deepEqual(chatApprovalOptions('bash'), [
      { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
      { optionId: 'allow_once', name: 'Allow Once', kind: 'allow_once' },
      { optionId: 'allow_always', name: 'Trust this tool', kind: 'allow_always' },
      { optionId: 'allow_session', name: 'Trust all tools for this session', kind: 'allow_session' },
    ]);
    assert.equal(chatApprovalOptions().find((option) => option.kind === 'allow_always')?.disabled, true);
    assert.equal(chatApprovalOptions('').find((option) => option.kind === 'allow_always')?.disabled, true);
  });
});
