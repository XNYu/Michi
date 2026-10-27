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
import { MICHI_PREAMBLE_HEAD, MICHI_PREAMBLE_TAIL } from 'michi-shared';

describe('buildStableSystemPrompt', () => {
    test('SDK sessions permit native questions without replacing legacy runtime instructions', () => {
        assert.match(buildStableSystemPrompt('sentinel', true, true), /Use AskUserQuestion or the Michi ask_user tool/);
        assert.doesNotMatch(buildStableSystemPrompt('sentinel', true), /Use AskUserQuestion or the Michi ask_user tool/);
    });
    test("the assistant's head advertises none of the ordinary chat tools", () => {
        // Tools and wording an assistant session cannot use.
        const ordinaryOnly = [/save_artifact/, /spawn_branches/, /_scheduled_job/, /show_image/, /spawn_agent/, /`bash`/,
            /Use AskUserQuestion or the Michi ask_user tool/];
        const previous = process.env.MICHI_SCHEDULED_JOBS;
        delete process.env.MICHI_SCHEDULED_JOBS;
        try {
            const ordinary = buildStableSystemPrompt('sentinel', true, true);
            for (const pattern of ordinaryOnly) assert.match(ordinary, pattern, `ordinary chats keep ${pattern}`);
            for (const prompt of [
                buildStableSystemPrompt('sentinel', true, false, 'assistant'),
                buildStableSystemPrompt('structured-tool', true, false, 'assistant'),
                buildPreamble({ enableFollowUps: true, cwd: '/tmp/x', toolCapabilities: 'assistant' }),
            ]) {
                for (const pattern of ordinaryOnly) assert.doesNotMatch(prompt, pattern);
                assert.match(prompt, /Michi assistant's own, described in this conversation's opening instructions/);
            }
            // Its structured questions go through Michi's ask_user tool.
            assert.match(buildStableSystemPrompt('sentinel', true, false, 'assistant'), /____michi_internal____ask_user/);
        } finally {
            if (previous === undefined) delete process.env.MICHI_SCHEDULED_JOBS;
            else process.env.MICHI_SCHEDULED_JOBS = previous;
        }
    });
    test('ordinary chats are pointed at the Tasks section before organizing tasks, and the other heads are not', () => {
        for (const prompt of [buildStableSystemPrompt('sentinel', true, true), buildPreamble({ enableFollowUps: true, cwd: '/tmp/x' })]) {
            assert.match(prompt, /Tasks section of the `pages-and-components` document with `michi_docs`/);
            assert.match(prompt, /plain question about them from it, read-only, and when there are none say so/);
            assert.match(prompt, /even a short answered question, is evidence for a Done task/);
        }
        for (const toolCapabilities of ['assistant', 'maintenance'] as const) {
            assert.doesNotMatch(buildPreamble({ enableFollowUps: true, cwd: '/tmp/x', toolCapabilities }), /Tasks section/);
        }
    });
    test('Spaces replies have their own Michi prompt without ordinary conversation metadata', () => {
        const metadata = /\[TITLE:|\[FOLLOW-UP|\[BRANCH-OVERVIEW:|set_branch_overview|set_follow_ups|structured metadata tool|branch-journal/;
        for (const enableFollowUps of [true, false]) {
            for (const mode of ['sentinel', 'sentinel-followups-tool-overview', 'structured-tool'] as const) {
                const prompt = buildStableSystemPrompt(mode, enableFollowUps, false, 'assistant');
                assert.match(prompt, /^You are Michi,/);
                assert.doesNotMatch(prompt, metadata);
            }
            const preamble = buildPreamble({ enableFollowUps, cwd: '/tmp/x', toolCapabilities: 'assistant' });
            assert.match(preamble, /^You are Michi,/);
            assert.doesNotMatch(preamble, metadata);
        }
        assert.match(buildStableSystemPrompt(), /\[TITLE:|\[FOLLOW-UP|\[BRANCH-OVERVIEW:/);
        assert.match(buildStableSystemPrompt('sentinel', false, false, 'maintenance'), /Scheduled maintenance mode/);
    });
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
});

describe('buildFirstTurnPrefix', () => {
    test('renders reference-kind extraContexts', () => {
        const s = buildFirstTurnPrefix({
            cwd: '/tmp/x',
            extraContexts: [{ name: 'styleguide', filePath: 'docs/style.md', kind: 'reference' }],
        });
        assert.match(s, /### @styleguide/);
        assert.match(s, /Referenced file at: docs\/style\.md/);
    });

    test('renders link-type extraContexts as [Link: url] (never reads a file)', () => {
        const s = buildFirstTurnPrefix({
            cwd: '/tmp/x',
            extraContexts: [
                { name: 'stripe-refunds', filePath: '', url: 'https://stripe.com/docs/refunds', kind: 'reference' },
            ],
        });
        assert.match(s, /### @stripe-refunds/);
        assert.match(s, /\[Link: https:\/\/stripe\.com\/docs\/refunds\]/);
        // A link must NOT be rendered as a file reference.
        assert.doesNotMatch(s, /Referenced file at:/);
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

describe('the preamble markers the Michi peek reads', () => {
    // The peek hides Michi's preamble in a Kiro conversation Michi read back by
    // these exact lines (shared/src/michiPreamble.ts); keep them in step.
    test('opens with MICHI_PREAMBLE_HEAD and hands over with MICHI_PREAMBLE_TAIL', () => {
        for (const enableFollowUps of [true, false]) {
            for (const toolCapabilities of ['michi', 'crew'] as const) {
                const preamble = buildPreamble({ enableFollowUps, toolCapabilities, cwd: '/tmp/x', workspaceInstructions: 'Be brief.' });
                assert.ok(preamble.startsWith(`${MICHI_PREAMBLE_HEAD}\n`), 'starts with the head line');
                assert.ok(preamble.endsWith(`\n${MICHI_PREAMBLE_TAIL}\n`), 'ends with the tail line');
                assert.equal(preamble.split(`\n${MICHI_PREAMBLE_TAIL}\n`).length, 2, 'the tail line appears once');
            }
        }
    });
});
