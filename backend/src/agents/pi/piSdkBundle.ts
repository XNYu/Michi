// Native ESM sidecar: the SDK and provider adapters rely on import.meta.url.
// Keep all Pi modules in one bundle so extensions use the same runtime registry.
// @ts-ignore - exports subpath is resolved by esbuild, not node10 resolution
export * as ai from '@earendil-works/pi-ai/compat';
export * as core from '@earendil-works/pi-agent-core';
export * as coding from '@earendil-works/pi-coding-agent';
// @ts-ignore - typebox ships ESM-only types; esbuild resolves it
export * as typebox from 'typebox';
