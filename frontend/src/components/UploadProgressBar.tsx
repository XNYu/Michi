import React from 'react';
import type { UploadPhase } from '../services/api';

export interface UploadProgressViewState {
  fileName: string;
  fileIndex: number;
  fileCount: number;
  phase: UploadPhase;
  percent: number | null;
}

interface Props {
  progress: UploadProgressViewState | null;
  compact?: boolean;
}

export default function UploadProgressBar({ progress, compact = false }: Props) {
  if (!progress) return null;
  const percent = progress.percent == null
    ? (progress.phase === 'preparing' ? 4 : 12)
    : Math.max(0, Math.min(100, progress.percent));
  const phase = progress.phase === 'preparing' ? 'preparing' : 'uploading';
  const countLabel = progress.fileCount > 1
    ? ` ${progress.fileIndex + 1}/${progress.fileCount}`
    : '';

  return (
    <div className={`t-upload-progress${compact ? ' is-compact' : ''}`}>
      <div className="t-upload-progress__head">
        <span className="t-upload-progress__label">
          {phase}{countLabel}
        </span>
        <span className="t-upload-progress__name" title={progress.fileName}>
          {progress.fileName}
        </span>
        <span className="t-upload-progress__pct">
          {progress.percent == null ? '--' : `${percent}%`}
        </span>
      </div>
      <div className="t-upload-progress__track" aria-hidden>
        <div
          className="t-upload-progress__bar"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
