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
    buildMetadataSystemPrompt,
    buildFirstTurnPrefix,
    buildPreamble,
} from '../src/agents/preamble';

describe('buildStableSystemPrompt', () => {
    test('returns identical string on every call (pure constant)', () => {
        const a = buildStableSystemPrompt();
        const b = buildStableSystemPrompt();
        assert.equal(a, b);
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

    test('structured-tool mode contains no overview or follow-up sentinel protocol', () => {
        const s = buildStableSystemPrompt('structured-tool');
        assert.match(s, /runtime's structured metadata tool/);
        assert.match(s, /\[TITLE:/);
        assert.doesNotMatch(s, /\[FOLLOW-UP/);
        assert.doesNotMatch(s, /\[FOLLOW-UPS:/);
        assert.doesNotMatch(s, /\[BRANCH-OVERVIEW:/);
        assert.doesNotMatch(s, /STRICT FORMAT RULES/);
    });

    test('hybrid mode keeps title and follow-up sentinels but removes overview from the body', () => {
        const s = buildStableSystemPrompt('sentinel-followups-tool-overview');
        assert.match(s, /\[TITLE:/);
        assert.match(s, /\[FOLLOW-UP 1\/3:/);
        assert.match(s, /STRICT FORMAT RULES/);
        assert.match(s, /runtime's structured metadata tool/);
        assert.match(s, /Never emit a \[BRANCH-OVERVIEW:\] sentinel/);
        assert.doesNotMatch(s, /\[BRANCH-OVERVIEW: 1-3 concise sentences/);
    });
});

describe('buildFirstTurnPrefix', () => {
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
        assert.doesNotMatch(s, /\[BRANCH-OVERVIEW:/);
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
        const stable = buildMetadataSystemPrompt();
        const full = buildPreamble({
            enableFollowUps: true,
            cwd: '/tmp/x',
            contextManifest: [{ name: 'spec', filePath: 'docs/spec.md' }],
        });
        assert.ok(full.includes(stable), 'full preamble should contain the stable head verbatim');
        assert.match(full, /Workspace context files available/);
        assert.match(full, /spec — docs\/spec\.md/);
    });
});
