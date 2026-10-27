// A test's own Michi hub as the runtime port an adapter reports to, mapped
// the way michiRuntimeHost maps the process-wide one (owner → chat node).
import { michiSubagentSink, michiWorkflowSink } from '../../src/agents/michiRuntimeHost';
import type { BackgroundSubagentRegistry } from '../../src/services/backgroundSubagentRegistry';
import type { WorkflowRunHub } from '../../src/services/workflowRunHub';

export const subagentSink = (registry: BackgroundSubagentRegistry) => michiSubagentSink(() => registry);
export const workflowSink = (hub: WorkflowRunHub) => michiWorkflowSink(() => hub);
