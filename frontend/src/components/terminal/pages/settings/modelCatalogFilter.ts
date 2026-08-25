import type { AgentModelInfo } from '../../../../services/api';

export function filterModelCatalog(
  models: AgentModelInfo[],
  query: string,
): AgentModelInfo[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return models;

  return models.filter((model) =>
    [model.id, model.label, model.description]
      .filter((value): value is string => typeof value === 'string')
      .some((value) => value.toLocaleLowerCase().includes(normalized)),
  );
}
