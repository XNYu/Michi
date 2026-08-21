import React, { useEffect } from 'react';
import type { ToolCallState, SubagentInfo } from '../../state/chatTypes';
import { AgentBlockStyleOverride, type AgentBlockStyle } from '../../state/prefs';
import { cssVarsFor, PALETTES } from './tokens';
import type { TerminalPalette } from '../../state/prefs';
import { ToolCallGroup } from './ToolCallGroup';
import { TermThoughtBlock, type ThoughtSegment } from './MessageBlock';
import '../../index.css';

/**
 * DEV-ONLY specimen sheet for the agent-block variants (1b card / 1d
 * terminal), mirroring the "Agent Blocks Redesign" design-canvas mock so the
 * implementation can be screenshot-diffed against it. Mounted by index.tsx
 * when the URL carries `?specimen=agent-blocks`; never bundled into prod
 * flows (the import is behind import.meta.env.DEV).
 */

const THOUGHT_TEXT =
  'The tool rows re-render on every chunk because the group header recomputes its summary. ' +
  'I should memo the summary and check whether the payload block needs the same treatment.';

const BASE = 1_000_000;

function expandedTools(): ToolCallState[] {
  return [
    {
      id: 'read-1',
      title: 'Read',
      kind: 'read',
      detail: 'frontend/src/state/chatStore.tsx',
      status: 'completed',
      startedAt: BASE + 1000,
      endedAt: BASE + 1400,
    },
    {
      // No `detail` — the row line must come from inputJson extraction.
      id: 'grep-1',
      title: 'Grep',
      kind: 'grep',
      status: 'completed',
      startedAt: BASE + 1400,
      endedAt: BASE + 1600,
      inputJson: JSON.stringify({ pattern: 'term-shimmer|term-dot-i', path: 'frontend/src' }),
      output: 'index.css:1159\nindex.css:1179',
    },
    {
      // Claude-runtime shape: kind is the generic 'tool', bucket must resolve
      // via the title; detail is a raw input dump, not a display string.
      id: 'bash-1',
      title: 'Bash',
      kind: 'tool',
      detail: '{"command":"npm test -- ToolCallGroup"}',
      status: 'running',
      startedAt: BASE + 1600,
      inputJson: JSON.stringify({ command: 'npm test -- ToolCallGroup' }),
    },
    {
      id: 'edit-1',
      title: 'Edit',
      kind: 'edit',
      detail: 'MessageBlock.tsx',
      status: 'failed',
      startedAt: BASE + 1600,
      endedAt: BASE + 4200,
      inputJson: JSON.stringify({ path: 'MessageBlock.tsx', old_str: 'const [open, setOpen]…' }),
      output: 'Error: old_str not found in file (0 matches, expected exactly 1)',
    },
  ];
}

function collapsedTools(): ToolCallState[] {
  return [
    { id: 'c-read-1', title: 'Read', kind: 'read', detail: 'a.tsx', status: 'completed', startedAt: BASE + 1000, endedAt: BASE + 2400 },
    { id: 'c-read-2', title: 'Read', kind: 'read', detail: 'b.tsx', status: 'completed', startedAt: BASE + 2400, endedAt: BASE + 3200 },
    { id: 'c-grep-1', title: 'Grep', kind: 'grep', detail: 'x|y', status: 'completed', startedAt: BASE + 3200, endedAt: BASE + 4200 },
  ];
}

/** The user-reported scenario: interleaved thinking + tool bursts that the
 *  cluster path merges into ONE agent block. Tool shapes mirror real Claude
 *  runtime data (kind 'tool', empty or JSON-dump detail, MCP-prefixed name). */
function mergedSegments(): ThoughtSegment[] {
  return [
    {
      key: 'm-t1',
      kind: 'text',
      text: 'Let me trace the original QueueDepthThreshold DAO to find who it calls and how defaults are handled.',
    },
    {
      key: 'm-g1',
      kind: 'tools',
      tools: [
        {
          id: 'm-search',
          title: 'mcp__code-index__code_search',
          kind: 'tool',
          detail: '',
          status: 'completed',
          startedAt: BASE + 1000,
          endedAt: BASE + 2200,
          inputJson: JSON.stringify({ query: 'QueueDepthThreshold DAO callers' }),
          output: 'backend/src/dao/QueueDepthThresholdDao.java',
        },
        {
          id: 'm-bash1',
          title: 'Bash',
          kind: 'tool',
          detail: '{"command":"rg -n \\"QueueDepthThreshold\\" --type java"}',
          status: 'completed',
          startedAt: BASE + 2200,
          endedAt: BASE + 3400,
          inputJson: JSON.stringify({ command: 'rg -n "QueueDepthThreshold" --type java' }),
        },
      ],
    },
    {
      key: 'm-t2',
      kind: 'text',
      text: "Now I can see the picture. Checking what TaskSchedulerServiceClient returns for missing regions — looking for usages or model definitions.",
    },
    {
      key: 'm-g2',
      kind: 'tools',
      tools: [
        {
          id: 'm-read',
          title: 'Read',
          kind: 'tool',
          detail: '',
          status: 'completed',
          startedAt: BASE + 3400,
          endedAt: BASE + 4100,
          inputJson: JSON.stringify({ file_path: 'backend/src/client/TaskSchedulerServiceClient.java' }),
        },
        {
          id: 'm-bash2',
          title: 'Bash',
          kind: 'tool',
          detail: '',
          status: 'running',
          startedAt: BASE + 4100,
          inputJson: JSON.stringify({ command: 'rg -n "TaskSchedulerServiceClient" backend/src' }),
        },
      ],
    },
  ];
}

const MERGED_TEXT = mergedSegments()
  .filter((s): s is Extract<ThoughtSegment, { kind: 'text' }> => s.kind === 'text')
  .map((s) => s.text)
  .join('\n\n');

const SUBAGENT_MISSION = 'Review ToolCallGroup.tsx for perf regressions and flag unnecessary re-renders';

function subagentTool(): ToolCallState[] {
  return [
    {
      id: 'sub-1',
      title: 'Task',
      status: 'running',
      detail: JSON.stringify({
        subagent_type: 'code-reviewer',
        description: SUBAGENT_MISSION,
        model: 'sonnet-4.6',
      }),
      startedAt: BASE + 1000,
    },
  ];
}

const SUBAGENTS: SubagentInfo[] = [
  {
    sessionId: 's1',
    sessionName: 'Code Reviewer',
    agentName: 'code-reviewer',
    initialQuery: SUBAGENT_MISSION,
    status: 'working',
    group: 'g1',
    dependsOn: [],
    currentTool: 'grep MessageBlock.tsx',
  },
];

function SectionLabel({ children, first }: { children: React.ReactNode; first?: boolean }) {
  return (
    <div
      style={{
        fontFamily: 'var(--ui-font)',
        fontSize: 8.5,
        letterSpacing: '.12em',
        textTransform: 'uppercase',
        color: 'var(--term-faint)',
        margin: first ? '0 0 6px' : '16px 0 6px',
      }}
    >
      {children}
    </div>
  );
}

function SpecimenPanel({ palette, label }: { palette: TerminalPalette; label: string }) {
  const vars = cssVarsFor(palette, PALETTES[palette].accent) as React.CSSProperties;
  return (
    <div
      data-panel={label}
      style={{
        ...vars,
        width: 400,
        flexShrink: 0,
        background: 'var(--term-bg)',
        border: palette === 'monokai' ? '1px solid #1d1e19' : '1px solid var(--term-line)',
        padding: '18px 20px 22px',
        color: 'var(--term-fg)',
      }}
    >
      {/* Same wrapper class the real message list applies, so MarkdownContent
          prose picks up the app's serif body treatment. */}
      <div className="terminal-message terminal-message-assistant" data-density="dense">
        <SectionLabel first>streaming · thinking</SectionLabel>
        <TermThoughtBlock text={THOUGHT_TEXT} streaming />
        <SectionLabel>done · collapsed</SectionLabel>
        <TermThoughtBlock text={THOUGHT_TEXT} toolCount={3} durationMs={12_000} />
        <SectionLabel>merged agent block · thinking + tools interleaved</SectionLabel>
        <TermThoughtBlock
          text={MERGED_TEXT}
          segments={mergedSegments()}
          toolCount={4}
          durationMs={8_400}
          initialMode="expanded"
        />
        <SectionLabel>tool calls · expanded</SectionLabel>
        <ToolCallGroup tools={expandedTools()} defaultExpanded />
        <SectionLabel>tool calls · collapsed</SectionLabel>
        <ToolCallGroup tools={collapsedTools()} defaultExpanded={false} />
        <SectionLabel>subagent</SectionLabel>
        <ToolCallGroup tools={subagentTool()} defaultExpanded subagents={SUBAGENTS} />
      </div>
    </div>
  );
}

function VariantRow({ variant, tag, title, desc }: { variant: AgentBlockStyle; tag: string; title: string; desc: string }) {
  return (
    <AgentBlockStyleOverride.Provider value={variant}>
      <div data-variant-row={tag} style={{ fontFamily: 'var(--ui-font)' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 10, fontWeight: 600, background: '#1a1916', color: '#fdfdfc', padding: '2px 6px' }}>{tag}</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#1a1916' }}>{title}</span>
        </div>
        <div style={{ fontSize: 11, color: '#70695d', marginBottom: 12, maxWidth: 830 }}>{desc}</div>
        <div style={{ display: 'flex', gap: 14 }}>
          <SpecimenPanel palette="bone" label={`${tag} Bone`} />
          <SpecimenPanel palette="monokai" label={`${tag} Monokai`} />
        </div>
      </div>
    </AgentBlockStyleOverride.Provider>
  );
}

export default function AgentBlocksSpecimen() {
  useEffect(() => {
    const s = document.documentElement.style;
    s.setProperty('--ui-font', "'Geist', system-ui, -apple-system, sans-serif, var(--ui-cjk-font)");
    s.setProperty('--font-mono', "'Geist Mono', 'IBM Plex Mono', Menlo, ui-monospace, monospace");
    document.body.style.background = '#e3e0d8';
  }, []);
  return (
    <div style={{ padding: '44px 48px 80px', display: 'flex', flexDirection: 'column', gap: 56, alignItems: 'flex-start' }}>
      <VariantRow
        variant="card"
        tag="1b"
        title="柔和卡片风 — implementation"
        desc="AgentBlockVariants.tsx CardToolGroup + MessageBlock card chrome, rendered with the app's real components."
      />
      <VariantRow
        variant="terminal"
        tag="1d"
        title="精致终端风 — implementation"
        desc="AgentBlockVariants.tsx TermToolGroup + MessageBlock terminal chrome, rendered with the app's real components."
      />
    </div>
  );
}
