import React from 'react';
import type { AgentRunInteractionDtoV1, JsonValue } from 'michi-shared';

export function AgentRunInteractions({ interactions, onRespond }: {
  interactions: readonly AgentRunInteractionDtoV1[];
  onRespond?: (interaction: AgentRunInteractionDtoV1, response: JsonValue) => void;
}) {
  if (interactions.length === 0) return null;
  return (
    <section aria-label="Run interactions" style={{ display: 'grid', gap: 6 }}>
      {interactions.map((interaction) => {
        const pending = interaction.status === 'pending';
        return (
          <div key={interaction.id} style={{ border: `1px solid ${pending ? 'var(--term-select)' : 'var(--term-line)'}`, background: pending ? 'var(--term-select-f)' : 'var(--term-surface)', padding: '10px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <strong style={{ color: 'var(--term-fg)', fontSize: 11 }}>{interaction.kind.replace('_', ' ')}</strong>
              <span style={{ color: pending ? 'var(--term-select)' : 'var(--term-muted)', fontSize: 10, marginLeft: 'auto', textTransform: 'uppercase' }}>{interaction.status}</span>
            </div>
            <pre style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', color: 'var(--term-mid)', fontFamily: 'var(--mono-font)', fontSize: 10 }}>
              {typeof interaction.request === 'string' ? interaction.request : JSON.stringify(interaction.request, null, 2)}
            </pre>
            {pending && onRespond && (
              <div data-testid="pending-interaction-actions" style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 8 }}>
                <button type="button" onClick={() => onRespond(interaction, { decision: 'deny' })}
                  style={{ border: '1px solid var(--term-danger)', background: 'transparent', color: 'var(--term-danger)', padding: '4px 8px', fontSize: 10, cursor: 'pointer' }}>Deny</button>
                <button type="button" onClick={() => onRespond(interaction, { decision: 'allow' })}
                  style={{ border: '1px solid var(--term-accent)', background: 'var(--term-accent)', color: 'var(--term-bg)', padding: '4px 8px', fontSize: 10, cursor: 'pointer' }}>Allow</button>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
