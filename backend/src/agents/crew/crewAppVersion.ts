// This import is bundled into the desktop backend as well as source builds.
import manifest from '../../../../crew-app/app.json';

export const CREW_APP_VERSION = manifest.version;

export function crewAppNeedsSync(installed: unknown, expected = CREW_APP_VERSION): boolean {
    const version = (value: unknown): number[] | null => {
        if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) return null;
        return value.split('.').map(Number);
    };
    const a = version(installed), b = version(expected);
    if (!a || !b) return true;
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] < b[i];
    }
    return false;
}
