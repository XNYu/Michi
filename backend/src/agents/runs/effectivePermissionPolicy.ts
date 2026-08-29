import {
  AgentPolicyCategory,
  AgentPolicyDecision,
  type AgentPermissionPolicyV1,
} from 'michi-shared';

const categories = Object.values(AgentPolicyCategory);
const rank: Record<AgentPolicyDecision, number> = {
  [AgentPolicyDecision.Deny]: 0,
  [AgentPolicyDecision.Ask]: 1,
  [AgentPolicyDecision.Allow]: 2,
};

function presetDecision(policy: AgentPermissionPolicyV1, category: AgentPolicyCategory): AgentPolicyDecision {
  const explicit = policy.categories[category];
  if (explicit) return explicit;
  if (policy.preset === 'research') {
    return [AgentPolicyCategory.Read, AgentPolicyCategory.Search, AgentPolicyCategory.Browse,
      AgentPolicyCategory.ArtifactWrite].includes(category)
      ? AgentPolicyDecision.Allow : AgentPolicyDecision.Deny;
  }
  if (policy.preset === 'build') {
    if ([AgentPolicyCategory.ExternalAction, AgentPolicyCategory.SpawnAgent].includes(category)) {
      return AgentPolicyDecision.Ask;
    }
    return AgentPolicyDecision.Allow;
  }
  return AgentPolicyDecision.Deny;
}

function minimumDecision(policies: readonly AgentPermissionPolicyV1[], category: AgentPolicyCategory): AgentPolicyDecision {
  return policies.map((policy) => presetDecision(policy, category))
    .reduce((left, right) => rank[left] <= rank[right] ? left : right);
}

/** Intersect permission ceilings. Omitted Definition/spawn/parent policies impose no
 * additional ceiling; platform and workspace policies are always required. */
export function intersectPermissionPolicies(input: {
  platform: AgentPermissionPolicyV1;
  workspace: AgentPermissionPolicyV1;
  parent?: AgentPermissionPolicyV1 | null;
  definition?: AgentPermissionPolicyV1 | null;
  spawn?: AgentPermissionPolicyV1 | null;
}): AgentPermissionPolicyV1 {
  const policies = [input.platform, input.workspace, input.parent, input.definition, input.spawn]
    .filter((policy): policy is AgentPermissionPolicyV1 => !!policy);
  return {
    version: 1,
    preset: 'custom',
    categories: Object.fromEntries(categories.map((category) => [category, minimumDecision(policies, category)])),
    maxDelegationDepth: Math.min(...policies.map((policy) => policy.maxDelegationDepth)),
    maxConcurrentRuns: Math.min(...policies.map((policy) => policy.maxConcurrentRuns)),
    maxWallTimeMs: Math.min(...policies.map((policy) => policy.maxWallTimeMs)),
    maxAttempts: Math.min(...policies.map((policy) => policy.maxAttempts)),
    maxTokens: nullableMinimum(policies.map((policy) => policy.maxTokens)),
    maxSpendMicros: nullableMinimum(policies.map((policy) => policy.maxSpendMicros)),
  };
}

function nullableMinimum(values: Array<number | null | undefined>): number | null {
  const bounded = values.filter((value): value is number => typeof value === 'number');
  return bounded.length ? Math.min(...bounded) : null;
}
