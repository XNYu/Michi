import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as root from '../src';
import {
  CHAT_APPROVAL_OPTION_IDS, decisionToOptionId, isPermissionOptionId, type HeadlessPermissionOptionId,
} from '../src/contract/permissions';

describe('permission vocabulary', () => {
  it('the package root exports it', () => {
    assert.equal(root.decisionToOptionId, decisionToOptionId);
    assert.equal(root.isPermissionOptionId, isPermissionOptionId);
    assert.equal(root.CHAT_APPROVAL_OPTION_IDS, CHAT_APPROVAL_OPTION_IDS);
  });

  it('lists the four option ids in chat order', () => {
    assert.deepEqual([...CHAT_APPROVAL_OPTION_IDS], ['reject_once', 'allow_once', 'allow_always', 'allow_session']);
  });

  it('recognizes only those ids', () => {
    for (const id of CHAT_APPROVAL_OPTION_IDS) assert.equal(isPermissionOptionId(id), true, id);
    for (const value of ['deny', 'allow', 'reject_always', 'michi:allow_always', 'ALLOW_ONCE', '', null, undefined, 1, {}]) {
      assert.equal(isPermissionOptionId(value), false, String(value));
    }
  });

  it('maps broker decisions onto headless option ids, a denial onto reject_once', () => {
    assert.equal(decisionToOptionId('allow_once'), 'allow_once');
    assert.equal(decisionToOptionId('allow_always'), 'allow_always');
    assert.equal(decisionToOptionId('deny'), 'reject_once');
    const headless: HeadlessPermissionOptionId[] = ['allow_once', 'allow_always', 'reject_once'];
    // @ts-expect-error a headless owner never answers allow_session
    const session: HeadlessPermissionOptionId = 'allow_session';
    assert.ok(!headless.includes(session));
  });
});
