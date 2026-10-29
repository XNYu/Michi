/** Opt-in integration checks against the user's running local Crew Gateway.
 * Consumes model calls and creates/deletes only its own diagnostic slots.
 * --memory additionally creates/removes one uniquely repository-scoped lesson.
 * Run after npm run backend:build: MICHI_CREW_LIVE_TEST=1 node backend/scripts/crew-live.cjs [--memory]
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { createCrewLiveFixture, textOf } = require('./crew-live-fixture.cjs');
const live = createCrewLiveFixture({
    prefix: 'michi-crew-live-', resultName: `michi-crew-live-${Date.now()}.json`, requestTimeoutMs: 10000,
});
const { gateway, model, template, cwd, slots, record, client, session, turn } = live;
const scope = path.basename(cwd);
// Crew repo_scope is an existing path INSIDE the project, not its basename.
fs.mkdirSync(path.join(cwd, scope));
const outputOf = events => events.filter(e => e.sessionUpdate === 'tool_call_update').map(e => e.rawOutput || '').join('\n');
const toolsOf = events => [...new Set(events.filter(e => e.sessionUpdate === 'tool_call_update').map(e => e.title))];

async function settings(sid) {
    const slot = (await gateway.listSlots()).find(row => row.key === sid);
    assert.ok(slot, 'Diagnostic slot is not owned by the configured App');
    return slot;
}
async function coreChecks() {
    const { c, sid } = await session('temporary');
    const marker = `CREW_FILE_${randomBytes(6).toString('hex')}`;
    const file = path.join(cwd, 'probe.txt');
    fs.writeFileSync(file, marker);
    const first = await turn(c, sid, `Disposable integration check. Read only ${file} with a file-reading tool, then reply with its exact contents and FIRST_TURN. Do not write files, save memory, schedule tasks, spawn agents, or use other tools.`);
    assert.ok(textOf(first).includes(marker));
    const starts = first.filter(e => e.sessionUpdate === 'tool_call');
    assert.ok(starts.length > 0 && starts.every(e => e.status === 'in_progress'));
    assert.ok(outputOf(first).includes(marker));
    assert.ok(first.some(e => e.sessionUpdate === 'tool_call_update' && e.status === 'completed'));
    assert.equal((await settings(sid)).memory_mode, 'temporary');
    record('tools, output and configured memory mode', {
        toolStarts: starts.length,
        titleEvents: first.filter(e => e.sessionUpdate === 'session_info_update').length,
        contextEvents: first.filter(e => e.sessionUpdate === 'context_usage').length,
    });
    const detail = await gateway.getSlot(sid);
    const mid = [...detail.messages].reverse().find(row => row.role === 'assistant' && row.meta?.mid)?.meta.mid;
    assert.ok(mid, 'No stable assistant message ID');
    assert.ok(textOf(await turn(c, sid, 'Reply exactly SECOND_TURN_98. No tools.')).includes('SECOND_TURN_98'));
    const child = await c.forkSession(sid, { messageId: mid });
    slots.push(child);
    const inherited = await gateway.getSlot(child);
    assert.ok(inherited.messages.some(row => row.meta?.mid === mid));
    assert.ok(!inherited.messages.some(row => String(row.content).includes('SECOND_TURN_98')));
    const childSettings = await settings(child);
    assert.equal(childSettings.memory_mode, 'temporary');
    assert.equal(childSettings.forked_from, `dashboard:${sid}`);
    await c.loadSession(child, cwd, []);
    assert.ok(textOf(await turn(c, child, 'Without tools, return the exact marker read from probe.txt.')).includes(marker));
    record('historical fork preserves boundary, memory mode and replayed transcript');
    assert.ok((await gateway.getSlot(sid)).messages.some(row => row.role === 'assistant' && String(row.content).includes('SECOND_TURN_98')), 'Fork must preserve the parent’s later assistant message');
    await c.shutdown();
    const restarted = await client('persistent');
    const loaded = await restarted.loadSession(sid, cwd, []);
    assert.equal(loaded.models.currentModelId, model);
    assert.equal((await settings(sid)).memory_mode, 'temporary', 'New-process defaults must not change resumed memory');
    const resumedReply = textOf(await turn(restarted, sid, 'In a previous message I gave a marker starting SECOND_TURN and ending with two digits. Return the exact complete string, including underscores and digits. Use conversation history only. No tools.'));
    assert.ok(resumedReply.includes('SECOND_TURN_98'), `Expected the resumed transcript marker, received: ${resumedReply}`);
    await restarted.setMode(sid, `template:${template}`);
    await restarted.setModel(sid, 'default');
    assert.equal((await settings(sid)).model, '');
    record('adapter restart resume, template switch and model-default reset');
}

let memoryCleanup;
async function memoryChecks() {
    const writer = await session('persistent');
    const marker = `CREW_MEMORY_${randomBytes(6).toString('hex')}`;
    const rule = `For acceptance checks in ${scope}, always label successful reports as ${marker}.`;
    // Retain the exact cleanup identity even if a model turn fails after writing.
    memoryCleanup = { ...writer, rule, scope };
    const write = await turn(writer.c, writer.sid, `Authorized disposable memory acceptance check. Please remember this reusable repository preference by calling learn_add exactly once: ${JSON.stringify({ rule, negative: 'Do not use an unlabelled success report in this diagnostic repository.', repo_scope: scope, category: 'preference' })}. Preserve text and scope. Use no other tools, change no files, and save no other memory. Report the tool result.`);
    assert.ok(toolsOf(write).some(name => /learn_add/.test(name)));
    assert.match(outputOf(write), /Saved lesson|Enriched lesson|already saved|already exists/i);
    assert.equal((await settings(writer.sid)).memory_mode, 'persistent');
    record('persistent native learn_add');
    const reader = await session('incognito');
    let read = await turn(reader.c, reader.sid, `Independent memory check in repository ${scope}. Use only memory_recall to retrieve the saved success-report labelling preference and return its exact label. Do not write memory, read files, or use other tools.`);
    record('independent session learned context', { markerRecovered: textOf(read).includes(marker) });
    if (!toolsOf(read).some(name => /memory_recall/.test(name))) {
        read = await turn(reader.c, reader.sid, `For this integration check, call memory_recall exactly once with query ${JSON.stringify(`${scope} acceptance checks successful reports label`)}, even if an injected correction already supplied the answer. Return the matching rule. Use no other tools and write no memory.`);
    }
    assert.ok(toolsOf(read).some(name => /memory_recall/.test(name)));
    assert.ok(outputOf(read).includes(marker) && textOf(read).includes(marker));
    assert.equal((await settings(reader.sid)).memory_mode, 'incognito');
    record('incognito native recall from an independent session');
    const isolated = await session('temporary');
    const readTemporary = await turn(isolated.c, isolated.sid, `Memory-boundary check in repository ${scope}. Attempt only memory_recall for its saved success-report label. If unavailable or disabled, explain that. Do not read files, use other tools, or write memory.`);
    assert.equal((await settings(isolated.sid)).memory_mode, 'temporary');
    assert.ok(!textOf(readTemporary).includes(marker) && !outputOf(readTemporary).includes(marker));
    record('temporary mode withheld the stored marker');
}
async function cleanup() {
    let failed = false;
    let retainSlot;
    if (memoryCleanup) {
        const { c, sid, rule, scope: repoScope } = memoryCleanup;
        try {
            const events = await turn(c, sid, `Check finished. Call only learn_remove exactly once with ${JSON.stringify({ query: rule, repo_scope: repoScope })}. This unique full rule and exact scope identify the diagnostic preference from our first turn. Remove no other lesson. Report the result.`);
            assert.ok(toolsOf(events).some(name => /learn_remove/.test(name)));
            assert.match(outputOf(events), /Removed lessons matching/);
            record('removed scoped diagnostic lesson');
        } catch (error) {
            // Do not conceal a failed cleanup; retain the exact, non-secret selector.
            failed = true;
            retainSlot = sid;
            record('memory cleanup requires attention', { error: String(error), rule, scope: repoScope });
        }
    }
    await live.cleanup({ retainSlot, failed });
}
(async () => {
    try {
        await coreChecks();
        if (process.argv.includes('--memory')) await memoryChecks();
    } catch (error) {
        live.report.error = String(error);
        console.error(String(error));
        process.exitCode = 1;
    } finally {
        await cleanup();
        live.writeReport();
    }
})();
