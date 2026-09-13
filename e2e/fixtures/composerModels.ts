import type { Page } from '@playwright/test';
import { installMockApi } from './mockApi';
import type { AgentCapabilities, AgentModelInfo, AgentOptionsPatch, AgentStatus } from '../../frontend/src/services/api/agentRuntime';

export const composerModels: Record<string, AgentModelInfo[]> = {
  codex: [
    { id: 'gpt-5.4', label: 'GPT-5.4', supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh'], defaultReasoning: 'medium' },
    { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh'], defaultReasoning: 'medium' },
    { id: 'extended', label: 'Extended model', supportedReasoningLevels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], defaultReasoning: 'high' },
    { id: 'limited', label: 'Limited model', supportedReasoningLevels: ['low', 'medium', 'high'], defaultReasoning: 'high' },
    { id: 'fixed', label: 'Fixed model', supportedReasoningLevels: ['high'] },
    { id: 'instant', label: 'Instant model', supportsReasoning: false, supportedReasoningLevels: [] },
  ],
  claude: [{ id: 'claude-opus-4-6', label: 'Claude Opus 4.6' }, { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' }],
  pi: Array.from({ length: 12 }, (_, index) => ({ id: `provider/model-${index}`, label: `Provider Model ${index}` })),
};
const capabilities: AgentCapabilities = {
  modes: false, permissions: false, models: true, providerModels: false, reasoning: true,
  supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh'], apiKeys: false,
  warmSessions: false, saveContext: false, spawnBranches: false,
};
const providers = ['openrouter', 'openai', 'local'].map((id) => ({ id, label: id === 'openai' ? 'OpenAI' : id === 'local' ? 'Local' : 'OpenRouter', keyLabel: 'API key', envVars: [], defaultModel: 'provider/model-0', supportsReasoning: id !== 'local', hasKey: true }));

export async function installComposerModels(page: Page, options: { failSave?: boolean; catalogDelay?: number } = {}) {
  const patches: AgentOptionsPatch[] = [];
  const ensures: Array<Record<string, unknown>> = [];
  const catalogRequests: string[] = [];
  const status: AgentStatus = {
    runtime: 'codex', label: 'Codex', model: 'gpt-5.4', reasoning: 'medium', customAgentsEnabled: false, hasRequiredKey: true,
    capabilities, providers,
    availableRuntimes: [{ id: 'codex', label: 'Codex', available: true }, { id: 'claude', label: 'Claude', available: true }, { id: 'pi', label: 'Pi', available: true }, { id: 'kiro', label: 'Kiro', available: false }],
  };
  await installMockApi(page, {
    custom: async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname.replace(/^.*\/api/, '');
      const json = async (body: unknown, code = 200) => { await route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(body) }); return true; };
      if (path === '/agent/status') return json(status);
      if (path === '/agent/options') {
        const patch = request.postDataJSON() as AgentOptionsPatch;
        patches.push(patch);
        if (options.failSave) { options.failSave = false; return json({ ok: false, error: 'Model settings could not be saved' }, 500); }
        Object.assign(status, patch);
        if (patch.runtime) {
          status.model = composerModels[patch.runtime as keyof typeof composerModels][0].id;
          status.reasoning = 'medium';
          status.provider = patch.runtime === 'pi' ? 'openrouter' : undefined;
          status.capabilities = { ...capabilities, providerModels: patch.runtime === 'pi' };
        }
        return json({ ok: true });
      }
      if (path === '/agent/models' || path === '/agent/runtime-catalog') {
        const runtime = url.searchParams.get('runtime') ?? status.runtime;
        catalogRequests.push(runtime);
        if (options.catalogDelay) await new Promise((resolve) => setTimeout(resolve, options.catalogDelay));
        return json({ models: composerModels[runtime as keyof typeof composerModels] ?? [], providers, capabilities: { ...capabilities, providerModels: runtime === 'pi' }, sanitizedModel: null });
      }
      if (request.method() === 'POST' && /^\/nodes\/[^/]+\/ensure-session$/.test(path)) ensures.push(request.postDataJSON());
      return false;
    },
  });
  return { patches, ensures, catalogRequests, status };
}
