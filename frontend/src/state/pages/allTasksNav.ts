/**
 * Opening All tasks from anywhere (the command palette). The terminal shell
 * answers the event, so the area, the view and the crumb all follow.
 */
export const OPEN_ALL_TASKS_EVENT = 'michi:open-all-tasks';

export function requestAllTasks(): void {
  window.dispatchEvent(new CustomEvent(OPEN_ALL_TASKS_EVENT));
}
