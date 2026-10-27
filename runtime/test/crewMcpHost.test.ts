import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createCrewMcpLoader } from '../src/adapters/crew/crewMcpHost';

function generation(name: string, delayed = false) {
    return `exports.CREW_MCP_HANDLER_API = 1; exports.createCrewMcpHandlers = () => ({
      listTools: async () => ({tools:[{name:${JSON.stringify(name)},inputSchema:{type:'object'}}]}),
      callTool: async () => { ${delayed ? 'await new Promise(resolve => setTimeout(resolve, 50));' : ''}
        return {content:[{type:'text',text:${JSON.stringify(name)}}]}; }
    });`;
}

test('missing, partial and incompatible rebuilds keep the valid generation, then recover', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crew-rebuild-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'relay.js');
    const load = createCrewMcpLoader(file);
    await assert.rejects(load(), /ENOENT/);
    await fs.writeFile(file, generation('valid'));
    const valid = await load();
    await fs.unlink(file);
    assert.equal(await load(), valid);
    await fs.writeFile(file, 'exports.createCrewMcpHandlers = (');
    assert.equal(await load(), valid);
    await fs.writeFile(file, 'exports = {};');
    assert.equal(await load(), valid);
    await fs.writeFile(file, generation('future').replace('HANDLER_API = 1', 'HANDLER_API = 2'));
    assert.equal(await load(), valid);
    await fs.writeFile(file, generation('recovered'));
    const calls = await Promise.all(Array.from({ length: 8 }, () => load()));
    assert.ok(calls.every(value => value === calls[0]));
    assert.equal((await calls[0].listTools()).tools[0].name, 'recovered');
});
