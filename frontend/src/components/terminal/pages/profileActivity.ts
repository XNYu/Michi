import { visibleMessageText } from '../../../state/assistantBlocks';
import type { ChatMessage, ChatNodeState, Project } from '../../../state/chatTypes';

export type ActivityMetric = 'nodes' | 'branches' | 'tokens';

export interface ActivityCell {
  dateKey: string;
  timestamp: number;
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
  isFuture: boolean;
}

export interface ActivityMetricSummary {
  cells: ActivityCell[];
  total: number;
  activeDays: number;
  longestStreak: number;
  currentStreak: number;
}

export interface ProfileActivity {
  totalNodes: number;
  totalThreads: number;
  totalBranches: number;
  metrics: Record<ActivityMetric, ActivityMetricSummary>;
}

const GRID_WEEKS = 53;
const GRID_DAYS = GRID_WEEKS * 7;

export function buildProfileActivity(
  projects: Project[],
  nodes: Record<string, ChatNodeState>,
  nowMs = Date.now(),
): ProfileActivity {
  const liveProjects = projects.filter((p) => !p.deletedAt);
  const projectById = new Map(liveProjects.map((p) => [p.id, p]));
  const nodeIds = new Set<string>();
  let totalThreads = 0;
  let totalBranches = 0;

  for (const project of liveProjects) {
    for (const id of project.chatIds) nodeIds.add(id);
    totalThreads += project.trees.length;
    totalBranches += project.edges.filter((e) => (e.kind ?? 'branch') === 'branch').length;
  }

  const dayCounts: Record<ActivityMetric, Map<string, number>> = {
    nodes: new Map(),
    branches: new Map(),
    tokens: new Map(),
  };

  let totalNodes = 0;
  for (const nodeId of nodeIds) {
    const node = nodes[nodeId];
    if (!node || node.deletedAt || node.kind === 'digest') continue;
    totalNodes += 1;

    const project = projectById.get(node.projectId);
    const firstActivityAt = firstNodeActivityAt(node, project?.createdAt);
    if (firstActivityAt) {
      addCount(dayCounts.nodes, firstActivityAt, 1);
      if (isBranchNode(node, project)) addCount(dayCounts.branches, firstActivityAt, 1);
    }

    for (const message of node.messages) {
      const ts = message.createdAt ?? firstActivityAt;
      if (!ts) continue;
      const approxTokens = estimateTokens(message);
      if (approxTokens > 0) addCount(dayCounts.tokens, ts, approxTokens);
    }
  }

  return {
    totalNodes,
    totalThreads,
    totalBranches,
    metrics: {
      nodes: summarizeMetric(dayCounts.nodes, nowMs),
      branches: summarizeMetric(dayCounts.branches, nowMs),
      tokens: summarizeMetric(dayCounts.tokens, nowMs),
    },
  };
}

function firstNodeActivityAt(node: ChatNodeState, fallback?: number): number | undefined {
  let first = Number.POSITIVE_INFINITY;
  for (const message of node.messages) {
    if (typeof message.createdAt !== 'number') continue;
    if (message.createdAt < first) first = message.createdAt;
  }
  if (Number.isFinite(first)) return first;
  return node.messages.length > 0 ? fallback : undefined;
}

function isBranchNode(node: ChatNodeState, project?: Project): boolean {
  if (node.parentNodeId) return true;
  if (!project) return false;
  return project.edges.some(
    (edge) => edge.target === node.nodeId && (edge.kind ?? 'branch') === 'branch',
  );
}

function estimateTokens(message: ChatMessage): number {
  const text = visibleMessageText(message).trim();
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function addCount(counts: Map<string, number>, timestamp: number, count: number) {
  const key = localDateKey(timestamp);
  counts.set(key, (counts.get(key) ?? 0) + count);
}

function summarizeMetric(counts: Map<string, number>, nowMs: number): ActivityMetricSummary {
  const today = startOfLocalDay(nowMs);
  const start = new Date(today);
  start.setDate(today.getDate() - (52 * 7 + today.getDay()));

  const seeded: Array<Omit<ActivityCell, 'level'>> = [];
  let max = 0;
  for (let i = 0; i < GRID_DAYS; i += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    const timestamp = date.getTime();
    const dateKey = localDateKey(timestamp);
    const isFuture = timestamp > today.getTime();
    const count = isFuture ? 0 : counts.get(dateKey) ?? 0;
    max = Math.max(max, count);
    seeded.push({ dateKey, timestamp, count, isFuture });
  }

  const cells = seeded.map((cell) => ({
    ...cell,
    level: activityLevel(cell.count, max),
  }));

  return {
    cells,
    total: cells.reduce((sum, cell) => sum + cell.count, 0),
    activeDays: cells.filter((cell) => cell.count > 0).length,
    longestStreak: longestStreak(cells),
    currentStreak: currentStreak(cells),
  };
}

function activityLevel(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0 || max <= 0) return 0;
  const ratio = count / max;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

function longestStreak(cells: ActivityCell[]): number {
  let best = 0;
  let current = 0;
  for (const cell of cells) {
    if (cell.isFuture) continue;
    if (cell.count > 0) {
      current += 1;
      best = Math.max(best, current);
    } else {
      current = 0;
    }
  }
  return best;
}

function currentStreak(cells: ActivityCell[]): number {
  let streak = 0;
  for (let i = cells.length - 1; i >= 0; i -= 1) {
    const cell = cells[i];
    if (cell.isFuture) continue;
    if (cell.count <= 0) break;
    streak += 1;
  }
  return streak;
}

function startOfLocalDay(timestamp: number): Date {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function localDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
