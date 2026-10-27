import React from 'react';
import { FileText } from 'lucide-react';
import './source.css';

/** The highlighted message's mark naming the page that cites it. */
export function SourceReferenceMark({ label }: { label: string | null }) {
  if (!label) return null;
  return (
    <div className="source-ref-mark">
      <FileText size={12} strokeWidth={1.7} aria-hidden="true" />
      <span>Referenced by page “{label}”</span>
    </div>
  );
}
