// Live check (no prompts, no model quota): Michi's AcpClient against real kiro-cli v3.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpClient } from '../src/adapters/kiro/acpClient';
import { KIRO_APPROVE_FOR_ME_PRESET } from '../src/adapters/kiro/kiroProtocol';

async function main() {
    const cwd = mkdtempSync(join(tmpdir(), 'michi-approve-live-'));
    const env = { ...process.env };
    delete env.KIRO_TRUST_CLASSIFIER_MODE;
    const client = new AcpClient(undefined, cwd, undefined, 'v3', undefined, 'kiro', { spawnEnv: () => env });
    const rules = async (sid: string) => {
        const res = await (client as any).send('_kiro/permissions/list', { sessionId: sid }, 30_000, sid);
        const presets = new Set((res.rules as any[]).filter((r) => typeof r.source === 'string' && r.source.startsWith('preset:')).map((r) => r.source));
        const evaluate = (res.rules as any[]).filter((r) => r.effect === 'evaluate').length;
        return `${res.rules.length} rules, presets=${JSON.stringify([...presets])}, evaluate=${evaluate}`;
    };
    try {
        client.start();
        await client.initialize(60_000);
        const plain = await client.newSession([], {});
        console.log('new (Ask):            ', await rules(plain.sessionId), 'tracked', JSON.stringify(client.policyPresets(plain.sessionId)));
        const seeded = await client.newSession([], { policyPresets: [KIRO_APPROVE_FOR_ME_PRESET] });
        console.log('new (Approve for me): ', await rules(seeded.sessionId), 'tracked', JSON.stringify(client.policyPresets(seeded.sessionId)));
        await client.reopenWithPolicyPresets(plain.sessionId, [KIRO_APPROVE_FOR_ME_PRESET]);
        console.log('reopen Ask -> AFM:    ', await rules(plain.sessionId), 'tracked', JSON.stringify(client.policyPresets(plain.sessionId)));
        await client.reopenWithPolicyPresets(seeded.sessionId, []);
        console.log('reopen AFM -> Ask:    ', await rules(seeded.sessionId), 'tracked', JSON.stringify(client.policyPresets(seeded.sessionId)));
        console.log('quarantined:          ', client.needsSessionRecovery(plain.sessionId), client.needsSessionRecovery(seeded.sessionId));
    } finally {
        await client.shutdown();
    }
}
main().then(() => process.exit(0), (error) => { console.error('FAILED', error); process.exit(1); });
