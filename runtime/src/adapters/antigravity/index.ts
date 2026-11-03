// Public entry of the Antigravity preset (`michi-runtime/adapters/antigravity`):
// createAntigravityRuntime, and the pieces it passes KiroRuntime to run
// Antigravity's `agy acp`.
export { createAntigravityRuntime, type AntigravityRuntimeOptions } from './antigravityRuntime';
export { ANTIGRAVITY_KIRO_FLAVOR } from './antigravityFlavor';
export { ANTIGRAVITY_DESCRIPTOR_OVERRIDE, ANTIGRAVITY_HARNESS, ANTIGRAVITY_STATIC_DESCRIPTOR } from './antigravityDescriptor';
export { antigravityAvailability, resolveAntigravityLaunch } from './antigravityLaunch';
export type { AntigravityAdapterOptions, AntigravityLaunchResolution } from './antigravityLaunch';
