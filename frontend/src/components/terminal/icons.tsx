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
