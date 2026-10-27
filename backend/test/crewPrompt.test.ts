import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { test } from 'node:test';

import { crewTurnFormat } from '../src/agents/hostText/kiro';
import { buildFirstTurnPrefix, buildPreamble } from '../src/agents/preamble';

test('Crew sends variable context without repeating the stable Michi instructions', () => {
    const input = {
        cwd: '/tmp', enableFollowUps: true, toolCapabilities: 'crew' as const,
        workspaceInstructions: 'Use our style guide.',
        contextManifest: [{ name: 'notes', filePath: 'notes.md' }],
        mergeContexts: ['A previous exploration.'],
    };
    const prefix = buildFirstTurnPrefix(input);
    assert.match(prefix, /Use our style guide\./);
    assert.match(prefix, /notes.md/);
    assert.match(prefix, /A previous exploration\./);
    assert.doesNotMatch(prefix, /michi_list_tools|Required final answer metadata/);
    assert.equal(buildFirstTurnPrefix({ cwd: '/tmp' }), '');
    const compact = prefix + 'Test1' + crewTurnFormat(true);
    const previous = buildPreamble(input) + 'Test1';
    assert.ok(compact.length < previous.length / 4);
    assert.match(crewTurnFormat(false), /Follow-ups are disabled/);
    assert.doesNotMatch(crewTurnFormat(false), /FOLLOW-UP 1\/3/);
});

test('the Crew App prompt points task organizing at the Tasks section through michi_call_tool', () => {
    const { prompt } = JSON.parse(fs.readFileSync(path.join(__dirname, '../../crew-app/agents/michi.json'), 'utf8'));
    assert.match(prompt, /Pages and their task boards/);
    assert.match(prompt, /Tasks section of the pages-and-components document with michi_docs \(through michi_call_tool\)/);
    assert.match(prompt, /even a short answered question, is evidence for a Done task/);
});
