import type { MobileAccessLink, MobileAccessProvider, MobileAccessStatus } from 'michi-shared';
import { TailscaleMobileAccess } from './tailscaleMobileAccess';

export interface MobileAccessController {
  status(): MobileAccessStatus | Promise<MobileAccessStatus>;
  start(): Promise<MobileAccessStatus>;
  stop(): Promise<MobileAccessStatus>;
  link(): MobileAccessLink;
  select?(provider: MobileAccessProvider): Promise<MobileAccessStatus>;
  login?(): Promise<MobileAccessStatus>;
  openApp?(): Promise<MobileAccessStatus>;
}

export function defaultMobileAccessProvider(): MobileAccessProvider { return 'tailscale'; }

export class MobileAccessManager implements MobileAccessController {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly services: Partial<Record<MobileAccessProvider, MobileAccessController>>, private provider: MobileAccessProvider) {
    this.service(provider);
  }
  private service(provider = this.provider): MobileAccessController {
    const service = this.services[provider];
    if (!service) throw new Error('This phone access method is unavailable in this Michi build.');
    return service;
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action); this.queue = result.catch(() => {}); return result;
  }
  async status(): Promise<MobileAccessStatus> {
    const provider = this.provider;
    const status = await this.service(provider).status();
    if (provider !== this.provider) return this.status();
    return { ...status, provider, providers: Object.keys(this.services) as MobileAccessProvider[] };
  }
  start() { return this.serial(async () => { await this.service().start(); return this.status(); }); }
  stop() { return this.serial(async () => { await this.service().stop(); return this.status(); }); }
  link() { return this.service().link(); }
  select(provider: MobileAccessProvider) {
    return this.serial(async () => {
      this.service(provider);
      if (provider !== this.provider) { await this.service().stop(); this.provider = provider; }
      return this.status();
    });
  }
  login() { return this.serial(async () => { await this.service().login?.(); return this.status(); }); }
  openApp() { return this.serial(async () => { await this.service().openApp?.(); return this.status(); }); }
}

/** Public builds contain only the private Tailscale Serve implementation. */
export function createMobileAccess(options: ConstructorParameters<typeof TailscaleMobileAccess>[0]) {
  return new MobileAccessManager({ tailscale: new TailscaleMobileAccess(options) }, 'tailscale');
}
