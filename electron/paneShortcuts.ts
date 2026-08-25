import type { Input } from 'electron';

type PaneShortcutInput = Pick<Input, 'type' | 'key' | 'meta' | 'control' | 'shift' | 'alt'>;

/**
 * Native WebContentsViews do not bubble keyboard events into the host renderer.
 * Match the host shell's close-pane shortcut without stealing modified variants
 * such as Shift+Cmd+W (which remains the native Close Window accelerator).
 */
export function isClosePaneShortcut(input: PaneShortcutInput, platform = process.platform): boolean {
  if (input.type !== 'keyDown' || input.key.toLowerCase() !== 'w' || input.shift || input.alt) return false;
  return platform === 'darwin'
    ? input.meta && !input.control
    : input.control && !input.meta;
}
