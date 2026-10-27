import React from 'react';
import { Code2 } from 'lucide-react';
import type { BlockProps } from '../blockTypes';
import { isObj, str } from '../michiPageModel';
import { BorderBtn } from '../../../primitives';

/** What a widget calls itself: its title, a title in its props, else its saved component's name. */
export function widgetTitle(block: BlockProps['block']): string {
  const props = isObj(block.props) ? block.props : {};
  return str(block.title).trim() || str(props.title).trim() || str(block.component).trim() || 'Widget';
}

/**
 * An agent-written widget (HTML and JS Michi would run in a sandbox). Michi
 * never runs model-written code, so it only says the widget is off.
 */
export function CustomBlock({ block }: BlockProps) {
  const title = widgetTitle(block);
  return (
    <div className="michi-doc-widget" data-michi-block="custom">
      <div className="michi-doc-widget__head">
        <span className="michi-doc-widget__glyph" aria-hidden="true"><Code2 size={12} strokeWidth={1.8} /></span>
        <span className="michi-doc-widget__title" title={title}>{title}</span>
        <span className="michi-doc-widget__state michi-doc-mono">off</span>
      </div>
      <div className="michi-doc-widget__body">
        <p>This widget is turned off</p>
        <BorderBtn
          className="michi-doc-ghost"
          onClick={() => window.dispatchEvent(new CustomEvent('michi:nav-page', { detail: { page: 'settings' } }))}
        >
          Settings
        </BorderBtn>
      </div>
    </div>
  );
}
