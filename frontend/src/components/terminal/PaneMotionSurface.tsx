import React from 'react';

interface Props {
  exiting: boolean;
  enterWidth?: number;
  children: React.ReactNode;
}

interface Snapshot {
  width: string;
  height: string;
  scroll: Array<{ element: HTMLElement; top: number; left: number }>;
}

/** Capture before the grid mutates, then freeze the retiring surface before paint. */
export default class PaneMotionSurface extends React.Component<Props> {
  private element = React.createRef<HTMLDivElement>();
  private activeChildren = this.props.children;

  getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
    const element = this.element.current;
    if (!element || previous.exiting || !this.props.exiting) return null;
    const style = getComputedStyle(element);
    return {
      width: style.width,
      height: style.height,
      scroll: Array.from(element.querySelectorAll<HTMLElement>('*'))
        .filter(child => child.scrollTop !== 0 || child.scrollLeft !== 0)
        .map(child => ({ element: child, top: child.scrollTop, left: child.scrollLeft })),
    };
  }

  componentDidUpdate(_previous: Props, _state: unknown, snapshot: Snapshot | null) {
    const element = this.element.current;
    if (!element) return;
    if (snapshot) {
      element.style.width = snapshot.width;
      element.style.height = snapshot.height;
      for (const { element: child, top, left } of snapshot.scroll) {
        child.scrollTop = top;
        child.scrollLeft = left;
      }
    } else if (!this.props.exiting) {
      element.style.width = this.props.enterWidth === undefined ? '100%' : `${this.props.enterWidth}px`;
      element.style.height = '100%';
    }
    if (!this.props.exiting) this.activeChildren = this.props.children;
  }

  render() {
    return (
      <div ref={this.element} className="pane-motion-surface" style={{
        width: this.props.enterWidth ?? '100%', height: '100%', flex: '0 0 auto',
        display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0,
      }}>
        {this.props.exiting ? this.activeChildren : this.props.children}
      </div>
    );
  }
}
