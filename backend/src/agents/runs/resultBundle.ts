import { parseResultBundleV1, type ResultBundleV1 } from 'michi-shared';

export function normalizeResultBundle(value: unknown): ResultBundleV1 {
  return parseResultBundleV1(value);
}

export function compactResultHandoff(bundle: ResultBundleV1): string {
  return [bundle.handoff.conclusion, bundle.handoff.artifactsOrChanges, bundle.handoff.unresolvedIssues]
    .map((part) => part.trim()).filter(Boolean).join('\n');
}
