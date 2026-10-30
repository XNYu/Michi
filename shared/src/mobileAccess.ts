export type MobileAccessProvider = 'tailscale';

export interface TailscaleSetup {
  state: 'not-installed' | 'not-running' | 'needs-login' | 'needs-approval' | 'ready' | 'error';
  account?: string;
  actionUrl?: string;
  message?: string;
  canOpenApp?: boolean;
}

export interface MobileAccessStatus {
  state: 'stopped' | 'starting' | 'connected' | 'reconnecting' | 'error';
  url: string;
  error: string;
  available: boolean;
  retryAt?: number;
  /** Optional for compatibility with older gateways. */
  provider?: MobileAccessProvider;
  providers?: MobileAccessProvider[];
  tailscale?: TailscaleSetup;
}

export interface MobileAccessLink {
  url: string;
  /** Legacy QR display deadline; ignored when reusable is true. */
  expiresAt: number;
  /** Stable authenticated URL, independent of browser pairing state. */
  reusable?: boolean;
}
