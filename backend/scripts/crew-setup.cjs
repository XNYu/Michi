/** Prepare App resources for the official Crew installer; never edits Crew source or grants consent. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const args = process.argv.slice(2);
// Accept old invocations, but always prepare the complete Michi integration.
if (args.some(arg => !['--approvals', '--mcp'].includes(arg))) throw new Error('Usage: node backend/scripts/crew-setup.cjs');
const root = path.resolve(__dirname, '..');
const relay = path.join(root, 'dist/crewMcp.js');
if (!fs.existsSync(relay)) throw new Error('Michi Crew MCP build is missing. Update Michi to a release with Crew support (michi update). For a source checkout, run npm run backend:build.');
const target = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-crew-app-'));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src/agents/crew/app/app.json'), 'utf8'));
fs.cpSync(path.join(root, 'src/agents/crew/app/agents'), path.join(target, 'agents'), { recursive: true });
manifest.mcpServers = { michi: { command: process.execPath, args: [relay], env: {
    MICHI_CREW_MCP_DIR: process.env.MICHI_CREW_MCP_DIR || path.join(os.homedir(), '.michi', 'crew-mcp'),
} } };
const agentPath = path.join(target, 'agents/michi.json');
const agent = JSON.parse(fs.readFileSync(agentPath, 'utf8'));
if (!agent.tools.includes('@michi-crew-runtime:michi')) agent.tools.push('@michi-crew-runtime:michi');
fs.writeFileSync(agentPath, JSON.stringify(agent, null, 2) + '\n');
manifest.permissions.sessionApproval = true;
manifest.description += ' Approval access includes user-owned Crew chats under the official grant; Michi restricts its adapter to its own App slots.';
fs.writeFileSync(path.join(target, 'app.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Prepared App: ${target}`);
console.log('Copy the prepared files into a persistent App source for first installation, or the existing App’s registered source before Sync. Crew Sync reuses that source; it does not choose this new temporary directory. Preserve the existing App secret; do not uninstall.');
console.log('Michi MCP and Approvals are included and required. In Crew Apps, complete sessionApproval consent and confirm the App is Enabled. The official grant also permits user-owned chats; it is broader than App-only access.');
console.log('In Crew Developer > MCP Management, find michi-crew-runtime:michi, inspect the Node launch, enable Stub/Routed and approve that launch. Restart the Gateway when requested (kirocrew restart); Apply & Restart only restarts chat agents. Keep this Michi build at its current path.');
console.log('After setup, use Michi for chats, Ask/Trust and approval cards. Crew supplies the backend.');
