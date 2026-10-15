/** Prepare App resources for the official Crew installer; never edits Crew source or grants consent. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.some(arg => !['--approvals', '--mcp'].includes(arg))) throw new Error('Usage: node backend/scripts/crew-setup.cjs [--mcp] [--approvals]');
const root = path.resolve(__dirname, '..');
const target = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-crew-app-'));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src/agents/crew/app/app.json'), 'utf8'));
fs.cpSync(path.join(root, 'src/agents/crew/app/agents'), path.join(target, 'agents'), { recursive: true });
if (args.includes('--mcp')) {
    const relay = path.join(root, 'dist/crewMcp.js');
    if (!fs.existsSync(relay)) throw new Error('Run npm run backend:build first');
    manifest.mcpServers = { michi: { command: process.execPath, args: [relay], env: {
        MICHI_CREW_MCP_DIR: process.env.MICHI_CREW_MCP_DIR || path.join(os.homedir(), '.michi', 'crew-mcp'),
    } } };
    const agentPath = path.join(target, 'agents/michi.json');
    const agent = JSON.parse(fs.readFileSync(agentPath, 'utf8'));
    agent.tools.push('@michi-crew-runtime:michi');
    fs.writeFileSync(agentPath, JSON.stringify(agent, null, 2) + '\n');
}
if (args.includes('--approvals')) {
    manifest.permissions.sessionApproval = true;
    manifest.description += ' Approval access includes user-owned Crew chats under the official grant; Michi restricts its adapter to its own App slots.';
}
fs.writeFileSync(path.join(target, 'app.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Prepared App: ${target}`);
console.log('Install or update this directory through Kiro Crew Apps. Preserve the existing App secret; do not uninstall.');
if (args.includes('--approvals')) console.log('In-app approvals require Crew’s explicit sessionApproval consent. The official grant also permits user-owned chats; it is broader than App-only access.');
if (args.includes('--mcp')) console.log('In Crew Developer > MCP Management, find michi-crew-runtime:michi, inspect the Node launch, enable Stub/Routed and approve that launch. Restart the Gateway when requested (kirocrew restart --port 5476); Apply & Restart only restarts chat agents. Keep this Michi build at its current path.');
