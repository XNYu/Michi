// Session owners for the package's tests: the runtime knows only a mode and a key.
import type { RuntimeSessionOwner } from '../src/contract/types';

/** An owner a person drives, keyed by the public id of its session. */
export const interactive = (key: string): RuntimeSessionOwner => ({ mode: 'interactive', key });

/** An owner nobody watches, keyed by the public id of its session. */
export const headless = (key: string): RuntimeSessionOwner => ({ mode: 'headless', key });
