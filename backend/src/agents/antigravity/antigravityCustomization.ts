import { spawnAgentProcess } from "../processTree";
import fs from "node:fs";
import path from "node:path";
import { buildMetadataSystemPrompt } from "../preamble";

export const ANTIGRAVITY_AGENT_NAME = "michi";

export interface AntigravityCustomization {
  rootDir: string;
  agentName: string;
  agentFile: string;
}

/**
 * Materialize a runtime-owned AGY custom agent. `--add-dir <rootDir>` makes
 * AGY discover `.agents/agents/michi/agent.md`, while `--agent michi` promotes
 * Michi's stable metadata contract out of the first user message and into the
 * agent instruction layer. The user's workspace is never modified.
 */
export function ensureAntigravityCustomization(dataDir: string): AntigravityCustomization {
  const rootDir = path.join(dataDir, "runtime-customizations", "antigravity");
  const agentFile = path.join(rootDir, ".agents", "agents", ANTIGRAVITY_AGENT_NAME, "agent.md");
  const content = [
    "---",
    `name: ${ANTIGRAVITY_AGENT_NAME}`,
    "description: Michi workspace assistant with stable response metadata",
    "---",
    "",
    buildMetadataSystemPrompt(),
    "",
  ].join("\n");

  fs.mkdirSync(path.dirname(agentFile), { recursive: true });
  if (!fs.existsSync(agentFile) || fs.readFileSync(agentFile, "utf8") !== content) {
    fs.writeFileSync(agentFile, content, { mode: 0o600 });
  }
  return { rootDir, agentName: ANTIGRAVITY_AGENT_NAME, agentFile };
}

/** Force AGY to scan the runtime-owned customization without spending a model
 * request or creating a throwaway conversation. */
export async function warmAntigravityCustomization(
  binaryPath: string,
  customization: AntigravityCustomization,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnAgentProcess(binaryPath, ["--add-dir", customization.rootDir, "agents"], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGTERM"), 15_000);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString();
      if (code === 0 && output.split(/\r?\n/).some((line) => line.trim() === customization.agentName)) {
        resolve();
        return;
      }
      const detail = Buffer.concat(stderr).toString().trim();
      reject(new Error(
        detail || `AGY did not discover custom agent ${customization.agentName} ` +
          `(code ${code ?? "null"}${signal ? `, signal ${signal}` : ""})`,
      ));
    });
  });
}
