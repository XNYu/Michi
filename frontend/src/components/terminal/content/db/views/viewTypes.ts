import type { MichiDatabase, MichiDbColumn, MichiDbEditOp, MichiDbView, MichiDbViewConfig, DatabaseRowStatus } from 'michi-shared';
import type { ThreadItemHandlers } from '../../threads/threadItem';
import type { GroupPrefs } from '../dbPrefs';
import type { DbGroup } from '../dbModel';

/**
 * How an edit is offered back: `undo` puts Undo on its toast (a card moved on a board). `undoOps`, when given,
 * are the edits Undo sends instead of putting the batch back (a reorder renumbers its neighbours, so it is moved back).
 */
export interface DbEditOptions {
  undo?: boolean;
  undoOps?: MichiDbEditOp[];
}

/** One edit with its undo-toast label; resolves to whether Michi took it. */
export type DbEdit = (ops: MichiDbEditOp[], label: string, options?: DbEditOptions) => Promise<boolean>;

/** What every view gets: the rows already filtered, sorted and grouped (applyView), and the ways to act on them. */
export interface DbViewProps {
  db: MichiDatabase;
  view: MichiDbView;
  /** The view's config as drawn (a board's fallback grouping filled in). */
  config: MichiDbViewConfig;
  groups: DbGroup[];
  /** The column `groups` split by, when grouped. */
  groupColumn?: MichiDbColumn;
  prefs: GroupPrefs;
  edit: DbEdit;
  handlers: ThreadItemHandlers;
  /** The Michi thread behind an All-threads row (state details, app, menu). */
  threadOf: (rowId: string) => DatabaseRowStatus | undefined;
  now: number;
  notice: (text: string) => void;
  /**
   * Views that page or place rows themselves (board columns, calendar days)
   * report the rows they draw, in reading order, for the peek's ↑/↓ and
   * Shift-click ranges.
   */
  onDrawn?: (ids: string[]) => void;
}
