import type { AgentModelInfo } from '../../services/api';

/** Keep provider IDs for requests, with a readable Claude fallback before catalog discovery. */
export function composerModelLabel(runtime: string, modelId: string | undefined, models: readonly AgentModelInfo[]): string {
  const label = models.find((model) => model.id === modelId)?.label;
  if (label && label !== modelId && !(runtime === 'claude' && label === 'Default')) return label;
  if (runtime === 'claude' && modelId) {
    const match = modelId.match(/(?:^|[.:/])claude-(fable|opus|sonnet|haiku)-(\d+)(?:[.-](\d{1,2}))?(?:-\d{8})?(\[\d+m\])?(?::[\w-]+)?$/i);
    if (match) {
      const [, family, major, minor, context] = match;
      const name = family[0].toUpperCase() + family.slice(1).toLowerCase();
      return `${name} ${major}${minor ? `.${minor}` : ''}${context ? ` (${context.slice(1, -1).toUpperCase()})` : ''}`;
    }
    if (/^(fable|opus|sonnet|haiku)$/i.test(modelId)) return modelId[0].toUpperCase() + modelId.slice(1).toLowerCase();
  }
  return label || modelId || 'Default model';
}
