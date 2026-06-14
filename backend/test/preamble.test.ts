/**
 * Tests for preamble split: buildStableSystemPrompt + buildFirstTurnPrefix.
 *
 * The stable system prompt is what Claude sees via --append-system-prompt at
 * spawn time. It MUST be a pure constant so every warm session in the pool
 * has byte-identical spawn args (otherwise the pool key (cwd, model) is
 * not well-defined).
 *
 * The first-turn prefix is what gets prepended to the user's first real
 * message. It carries per-chat context (cwd manifest, file blocks, ancestors,
 * merge blocks).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildStableSystemPrompt,
    buildFirstTurnPrefix,
    buildPreamble,
} from '../src/agents/preamble';

describe('buildStableSystemPrompt', () => {
    test('returns identical string on every call (pure constant)', () => {
        const a = buildStableSystemPrompt();
        const b = buildStableSystemPrompt();
        assert.equal(a, b);
    });

    test('always includes the FOLLOW-UP sentinel instruction', () => {
        const s = buildStableSystemPrompt();
        assert.match(s, /\[FOLLOW-UP 1\/3:/);
        assert.match(s, /STRICT FORMAT RULES/);
    });

    test('always includes the TITLE sentinel instruction', () => {
        const s = buildStableSystemPrompt();
        assert.match(s, /\[TITLE:/);
    });

    test('contains no cwd, contextManifest, or ancestor content', () => {
        const s = buildStableSystemPrompt();
        assert.doesNotMatch(s, /Workspace context files available/);
        assert.doesNotMatch(s, /Reference context the user has pinned/);
        assert.doesNotMatch(s, /Previous conversation chain/);
    });

    test('never includes the FOLLOW_UPS_DISABLED variant', () => {
        const s = buildStableSystemPrompt();
        assert.doesNotMatch(s, /Follow-ups are DISABLED/);
    });
});

describe('buildFirstTurnPrefix', () => {
    test('returns empty string when no variable inputs', () => {
        const s = buildFirstTurnPrefix({ cwd: '/tmp/x' });
        assert.equal(s, '');
    });

    test('includes contextManifest listing when provided', () => {
        const s = buildFirstTurnPrefix({
            cwd: '/tmp/x',
            contextManifest: [{ name: 'spec', filePath: 'docs/spec.md' }],
        });
        assert.match(s, /Workspace context files available/);
        assert.match(s, /spec — docs\/spec\.md/);
    });

    test('contains no follow-up or title sentinel instructions', () => {
        const s = buildFirstTurnPrefix({
            cwd: '/tmp/x',
            contextManifest: [{ name: 'spec', filePath: 'docs/spec.md' }],
        });
        assert.doesNotMatch(s, /\[FOLLOW-UP 1\/3:/);
        assert.doesNotMatch(s, /\[TITLE:/);
    });

    test('renders mergeContexts when provided', () => {
        const s = buildFirstTurnPrefix({
            cwd: '/tmp/x',
            mergeContexts: ['merge-block-1', 'merge-block-2'],
        });
        assert.match(s, /merge-block-1/);
        assert.match(s, /merge-block-2/);
        assert.match(s, /synthesize/);
    });

    test('includes workspaceInstructions when provided', () => {
        const s = buildFirstTurnPrefix({
            cwd: '/tmp/x',
            workspaceInstructions: 'Reply tersely. Cite file paths.',
        });
        assert.match(s, /Workspace instructions/);
        assert.match(s, /Reply tersely\. Cite file paths\./);
    });

    test('omits workspaceInstructions block when empty or whitespace', () => {
        const empty = buildFirstTurnPrefix({ cwd: '/tmp/x', workspaceInstructions: '' });
        const whitespace = buildFirstTurnPrefix({ cwd: '/tmp/x', workspaceInstructions: '   \n  ' });
        const nullish = buildFirstTurnPrefix({ cwd: '/tmp/x', workspaceInstructions: null });
        assert.equal(empty, '');
        assert.equal(whitespace, '');
        assert.equal(nullish, '');
    });

    test('workspaceInstructions appears before other variable sections', () => {
        const s = buildFirstTurnPrefix({
            cwd: '/tmp/x',
            workspaceInstructions: 'TERSE_MARKER',
            mergeContexts: ['MERGE_MARKER'],
        });
        assert.ok(s.indexOf('TERSE_MARKER') < s.indexOf('MERGE_MARKER'));
    });

    test('renders reference-kind extraContexts', () => {
        const s = buildFirstTurnPrefix({
            cwd: '/tmp/x',
            extraContexts: [{ name: 'styleguide', filePath: 'docs/style.md', kind: 'reference' }],
        });
        assert.match(s, /### @styleguide/);
        assert.match(s, /Referenced file at: docs\/style\.md/);
    });
});

describe('buildPreamble (legacy composition for Pi/Kiro)', () => {
    test('with enableFollowUps=true and contextManifest, includes stable head + variable section', () => {
        const stable = buildStableSystemPrompt();
        const full = buildPreamble({
            enableFollowUps: true,
            cwd: '/tmp/x',
            contextManifest: [{ name: 'spec', filePath: 'docs/spec.md' }],
        });
        assert.ok(full.includes(stable), 'full preamble should contain the stable head verbatim');
        assert.match(full, /Workspace context files available/);
        assert.match(full, /spec — docs\/spec\.md/);
    });

    test('with enableFollowUps=false swaps to DISABLED variant', () => {
        const full = buildPreamble({ enableFollowUps: false, cwd: '/tmp/x' });
        assert.match(full, /Follow-ups are DISABLED/);
        assert.doesNotMatch(full, /\[FOLLOW-UP 1\/3:/);
    });

    test('ends with the "user will now speak" tail', () => {
        const full = buildPreamble({ enableFollowUps: true, cwd: '/tmp/x' });
        assert.match(full, /The user will now speak\.\s*$/);
    });
});
