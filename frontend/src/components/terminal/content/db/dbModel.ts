import type { MichiDatabase, MichiDbViewConfig } from 'michi-shared';
import { michiOneLine } from '../michiPlainText';
import { applyView as applySharedView, isAgentOneLiner, type ConversationLookup } from '../../../../../../shared/src/database/viewModel';

// The calculations live in the browser-safe shared model. Michi keeps its
// one-line summary presentation rule at this adapter boundary.
export * from '../../../../../../shared/src/database/viewModel';

export function applyView(
  db: Pick<MichiDatabase, 'columns' | 'rows'> & Partial<Pick<MichiDatabase, 'id' | 'kind'>>,
  config: MichiDbViewConfig,
  extra: { conversation?: ConversationLookup } = {},
) {
  return applySharedView(db, config, {
    isOneLiner: (identity, column) => isAgentOneLiner(identity, column),
    oneLineText: michiOneLine,
    ...extra,
  });
}
