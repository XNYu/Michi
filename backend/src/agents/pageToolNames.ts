export const PAGE_TOOL_NAMES = [
  'read_home',
  'edit_home',
  'list_pages',
  'read_page',
  'edit_page',
  'create_page',
  'read_database',
  'edit_database',
  'list_page_components',
  'read_page_component',
  'save_page_component',
  'configure_database_view',
  'open_task_database',
  'list_tasks',
] as const;

export type PageToolName = typeof PAGE_TOOL_NAMES[number];

export interface ActivePageTurnAttribution {
  turnId: string;
  assistantId: string;
}

export type ActivePageTurnAttributionGetter = () => ActivePageTurnAttribution | null;
