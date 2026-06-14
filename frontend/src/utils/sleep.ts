export const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
