import React from 'react';
import type { PageLayoutRule } from 'michi-shared';
import { deleteLayoutRule } from '../../../../services/api/spacesHome';
import { notifyPageChanged } from '../../../../state/pages/pageEvents';
import '../pageChanges.css';
import './layoutRules.css';

/**
 * The change mark under a counted Home section a layout rule shapes, in the
 * section's hover controls: where it came from and Undo, which deletes the
 * rule so the section lists as before. Update times belong to the page header.
 */
export function LayoutRuleSectionMarks({ pageId, backendConnectionId, rules, ruleIds }: {
  pageId: string | null;
  backendConnectionId: string;
  rules: readonly PageLayoutRule[];
  /** From the section's answer: the rules that limited it. */
  ruleIds: readonly string[] | undefined;
  now?: number;
}) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);
  const shown = rules.filter((rule) => ruleIds?.includes(rule.id));
  if (!pageId || shown.length === 0) return null;
  const undo = async (rule: PageLayoutRule) => {
    if (busy) return;
    setBusy(rule.id);
    setFailed(null);
    try {
      await deleteLayoutRule(pageId, rule.id, backendConnectionId);
      notifyPageChanged({ backendConnectionId, pageId });
    } catch (cause) {
      setFailed(cause instanceof Error && cause.message ? `Couldn't undo: ${cause.message}` : "Couldn't undo this rule.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="page-change-targets" aria-label="Layout rules on this section">
      {shown.map((rule) => (
          <div key={rule.id} className="page-change-line" data-state="applied" data-quiet="true" data-testid="layout-rule-mark" title={`Layout rule: ${rule.text}`}>
            <span>Layout rule</span>
            <span aria-hidden="true">·</span>
            <span>{rule.createdBy === 'user' ? 'added by you' : rule.sourceMessage ? 'from Assistant' : 'by the Meta agent'}</span>
            <span aria-hidden="true">·</span>
            <button type="button" className="page-change-link" disabled={busy !== null} onClick={() => { void undo(rule); }}>Undo</button>
          </div>
      ))}
      {failed && <p className="page-change-card__error" role="alert">{failed}</p>}
    </div>
  );
}
