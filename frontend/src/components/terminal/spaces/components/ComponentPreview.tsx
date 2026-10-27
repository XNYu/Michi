import React from 'react';
import { SandboxFrame } from './SandboxFrame';

/** Gallery and editor preview always use synthetic data and omit the host capability. */
export function ComponentPreview({ connectionId, name, code, props = {} }: { connectionId: string; name: string; code: string; props?: Record<string, unknown> }) {
  return <div className="page-component-preview"><div className="page-component-preview-label">Sample preview · isolated data</div>
    <SandboxFrame connectionId={connectionId} name={name} code={code} props={props} data={{ sample: true, value: 12, label: 'Example', rows: [{ id: 'sample-1', title: 'Sample row', value: 12 }] }} preview minHeight={120} maxHeight={520} />
  </div>;
}
