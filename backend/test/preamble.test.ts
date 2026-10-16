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
    test('full-summary experiment changes overview wording only when enabled', () => {
        const previous = process.env.MICHI_NODE_SUMMARY_EXPERIMENT_MODE;
        try {
            delete process.env.MICHI_NODE_SUMMARY_EXPERIMENT_MODE;
            const normal = buildPreamble({ enableFollowUps: false, cwd: '/tmp/x' });
            assert.match(normal, /journal entry for this turn/);
            process.env.MICHI_NODE_SUMMARY_EXPERIMENT_MODE = 'full';
            const experimental = buildPreamble({ enableFollowUps: false, cwd: '/tmp/x' });
            assert.match(experimental, /full conversation as its CURRENT state/);
            assert.doesNotMatch(experimental, /journal entry for this turn/);
            const structured = buildStableSystemPrompt('structured-tool', false);
            assert.match(structured, /runtime's structured metadata tool/);
            assert.doesNotMatch(structured, /\[BRANCH-OVERVIEW:/);
        } finally {
            if (previous === undefined) delete process.env.MICHI_NODE_SUMMARY_EXPERIMENT_MODE;
            else process.env.MICHI_NODE_SUMMARY_EXPERIMENT_MODE = previous;
        }
    });
    test('Crew combines Michi tools with native memory guidance', () => {
        const crew = buildPreamble({ cwd: '/tmp', enableFollowUps: false, toolCapabilities: 'crew' });
        const kiro = buildPreamble({ cwd: '/tmp', enableFollowUps: false });
        assert.match(crew, /memory_recall/);
        assert.match(crew, /Temporary disables memory reads and writes/);
        assert.match(crew, /\[BRANCH-OVERVIEW:/);
        for (const name of ['michi_list_tools', 'michi_call_tool']) assert.ok(crew.includes(name));
        assert.doesNotMatch(crew, /tools are not attached/);
        assert.match(kiro, /`list_threads`/);
    });
    test('returns identical string on every call (pure constant)', () => {
        const a = buildStableSystemPrompt();
        const b = buildStableSystemPrompt();
        assert.equal(a, b);
    });

    test('Michi help is loaded on demand with reference-only scope', () => {
        for (const toolCapabilities of ['michi', 'crew'] as const) {
            const prompt = buildPreamble({ cwd: '/tmp', enableFollowUps: false, toolCapabilities });
            assert.match(prompt, /michi_docs/);
            assert.match(prompt, /not live settings or authorization/);
            assert.doesNotMatch(prompt, /Trust this tool saves a grant/);
        }
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

    test('always includes the BRANCH-OVERVIEW sentinel instruction', () => {
        const s = buildStableSystemPrompt();
        assert.match(s, /\[BRANCH-OVERVIEW:/);
        assert.match(s, /1-3 concise sentences/);
    });

    test('scopes metadata sentinels to final answers only', () => {
        const s = buildStableSystemPrompt();
        assert.match(s, /final answer only/);
        assert.match(s, /after all tool use and intermediate commentary is complete/);
        assert.match(s, /Do not emit \[TITLE:\], \[BRANCH-OVERVIEW:\], or \[FOLLOW-UP n\/3:\] sentinel lines in commentary/);
        assert.match(s, /Near the end of the final answer, write three lines/);
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
