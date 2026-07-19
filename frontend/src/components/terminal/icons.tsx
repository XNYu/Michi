import React from 'react';

interface IconProps {
  size?: number;
  className?: string;
}

const base = (size: number): React.SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
});

export function HomeIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M2.5 8 L8 3 L13.5 8" />
      <path d="M4 7.4 V13 H12 V7.4" />
      <path d="M6.8 13 V9.8 H9.2 V13" />
    </svg>
  );
}

export function MapIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 2v12M2 8h12" />
    </svg>
  );
}

export function BranchesIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M3 2.5h8M5 6.5h8M7 10.5h6M7 14h4" />
      <path d="M3 2.5v4h2M5 6.5v4h2M7 10.5V14" />
    </svg>
  );
}

export function DigestIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M3 3h10M3 7h10M3 11h6" />
    </svg>
  );
}

export function WorkspacesIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
    </svg>
  );
}

export function ArtifactsIcon({ size = 14, className }: IconProps) {
  // Stacked layers — reads as "a collection of things" (the artifact shelf).
  return (
    <svg {...base(size)} className={className}>
      <path d="M8 2l6 3-6 3-6-3 6-3z" />
      <path d="M2 8l6 3 6-3" />
      <path d="M2 11l6 3 6-3" />
    </svg>
  );
}

export function SettingsIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4" />
    </svg>
  );
}

export function UserIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="8" cy="6" r="2.6" />
      <path d="M3 14a5 5 0 0 1 10 0" />
    </svg>
  );
}

export function CopyIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="5.5" y="5.5" width="8.5" height="8.5" rx="1.5" />
      <path d="M3.5 10.5h-.5A1.5 1.5 0 0 1 1.5 9V3A1.5 1.5 0 0 1 3 1.5h6A1.5 1.5 0 0 1 10.5 3v.5" />
    </svg>
  );
}

export function RetryIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9L13.5 5.5" />
      <path d="M13.5 2v3.5H10" />
    </svg>
  );
}

export function EditIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M11.3 2.1a1.85 1.85 0 0 1 2.6 2.6L5.2 13.4l-3.5.9.9-3.5z" />
    </svg>
  );
}

export function BranchIcon({ size = 14, className }: IconProps) {
  // Git-branch fork — trunk with a child splitting off.
  return (
    <svg {...base(size)} className={className}>
      <circle cx="4" cy="12" r="2" />
      <circle cx="12" cy="4" r="2" />
      <path d="M4 2v8" />
      <path d="M12 6a6 6 0 0 1-6 6" />
    </svg>
  );
}

export function CheckIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M3 8.5l3.5 3.5L13 5" />
    </svg>
  );
}
