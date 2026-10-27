import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ComponentSandboxMethod } from 'michi-shared';
import { SandboxFrame } from '../src/components/terminal/spaces/components/SandboxFrame';

declare global {
  interface Window {
    renderComponentSandboxHarness(input: {
      code: string;
      preview?: boolean;
      stable?: boolean;
      connectionId?: string;
      props?: Record<string, unknown>;
      data?: unknown;
    }): void;
    updateComponentSandboxHarness(input: { code?: string; props?: Record<string, unknown>; data?: unknown }): void;
    componentSandboxHarnessCalls: Array<{ method: ComponentSandboxMethod; args: unknown[] }>;
    componentSandboxHarnessAskDrafts: string[];
    componentSandboxHarnessNavigations: string[];
  }
}

let root: Root | null = null;
let activeInput: Parameters<Window['renderComponentSandboxHarness']>[0] | null = null;
window.componentSandboxHarnessCalls = [];
window.componentSandboxHarnessAskDrafts = [];
window.componentSandboxHarnessNavigations = [];
const renderHarness = (input: Parameters<Window['renderComponentSandboxHarness']>[0]) => {
  root ??= createRoot(document.getElementById('root')!);
  activeInput = input;
  root.render(<SandboxFrame
    connectionId={input.connectionId ?? 'local'}
    name="Security harness"
    code={input.code}
    props={input.props ?? { title: 'Harness' }}
    data={input.data ?? { secret: 'fixture-secret', rows: [{ id: 'row-1' }] }}
    preview={input.preview}
    stable={input.stable}
    capability={{ token: 'fixture-capability', call: async (method, args) => {
      window.componentSandboxHarnessCalls.push({ method, args });
      return { ok: true };
    } }}
    onAskDraft={(draft) => window.componentSandboxHarnessAskDrafts.push(draft)}
    onNavigate={(pageId) => window.componentSandboxHarnessNavigations.push(pageId)}
  />);
};
window.renderComponentSandboxHarness = (input) => renderHarness(input);
window.updateComponentSandboxHarness = (input) => {
  if (!activeInput) throw new Error('Render the component sandbox harness before updating it');
  renderHarness({ ...activeInput, ...input, props: { ...(activeInput.props ?? { title: 'Harness' }), ...(input.props ?? {}) } });
};
