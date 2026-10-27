/**
 * The Crew App version this adapter expects installed: the `version` of the
 * repository's crew-app/app.json, kept here as a constant so the package
 * carries no file from outside it. Bump both together;
 * test/crewAppVersion.test.ts fails while they differ.
 */
export const CREW_APP_VERSION: string = '0.6.1';

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
