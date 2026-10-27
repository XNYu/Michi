import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilitiesForHost, capabilityReadHostSucceeded, isExpectedDeletedComponentRead, isExpectedDisabledComponent404, oldCapabilityCallsAfterOwnerReplacement, recordMintedComponentCapability } from './pages-real-ui-capability-evidence.mjs';

test('a delayed second-page mint is included in owner snapshots and matched to its own host', async () => {
  const owners = new Map();
  const traffic = [];
  const host = { kind: 'page_block', pageId: 'pg-live', blockId: 'block-live' };
  const mint = (page, token, issuedAt) => {
    const event = { path: '/api/component-capabilities', method: 'POST', status: 201 };
    traffic.push(event);
    recordMintedComponentCapability(owners, event, { postData: () => JSON.stringify({ componentId: 'pc-live', host }) }, { capability: token }, page, issuedAt);
  };
  mint('first', 'old-first', 10);
  assert.equal(capabilitiesForHost(owners, 'pc-live', host, 'second').length, 0);

  await new Promise((resolve) => setTimeout(resolve, 5));
  mint('second', 'old-second', 20);
  assert.deepEqual(capabilitiesForHost(owners, 'pc-live', host, 'first').map(([token]) => token), ['old-first']);
  assert.deepEqual(capabilitiesForHost(owners, 'pc-live', host, 'second').map(([token]) => token), ['old-second']);

  const replacement = { path: '/api/component-capabilities/new-second', method: 'POST', status: 200, requestBody: JSON.stringify({ method: 'read.host' }) };
  traffic.push(replacement);
  assert.equal(capabilityReadHostSucceeded(traffic, 'new-second'), true);
  assert.equal(capabilityReadHostSucceeded(traffic, 'old-second'), false);
});

test('old capability calls use the replacement time for their owning window', () => {
  const owners = new Map([
    ['old-first', { page: 'first' }],
    ['old-second', { page: 'second' }],
  ]);
  const oldTokens = new Set(['old-first', 'old-second']);
  const replacements = { first: { issuedAt: 100 }, second: { issuedAt: 200 } };
  const call = (token, at) => ({ path: `/api/component-capabilities/${token}`, method: 'POST', at });

  // The second window may still surface its one revoked-token response while
  // the first window has already recovered and before the second one replaces.
  assert.deepEqual(oldCapabilityCallsAfterOwnerReplacement([call('old-second', 150)], owners, oldTokens, replacements), []);
  assert.deepEqual(oldCapabilityCallsAfterOwnerReplacement([{ ...call('old-second', 205), requestStartedAt: 199 }], owners, oldTokens, replacements), []);
  assert.deepEqual(oldCapabilityCallsAfterOwnerReplacement([{ ...call('old-second', 210), requestStartedAt: 201 }], owners, oldTokens, replacements).map((event) => event.at), [210]);
  assert.deepEqual(oldCapabilityCallsAfterOwnerReplacement([{ ...call('old-second', 210), requestStartedAt: 0 }], owners, oldTokens, replacements).map((event) => event.at), [210]);
  assert.deepEqual(oldCapabilityCallsAfterOwnerReplacement([{ ...call('old-first', 101), requestStartedAt: 101 }], owners, oldTokens, replacements).map((event) => event.at), [101]);
  // Missing ownership or its replacement watermark must fail closed.
  assert.deepEqual(oldCapabilityCallsAfterOwnerReplacement([call('old-second', 150)], new Map(), oldTokens, replacements), [call('old-second', 150)]);
  assert.deepEqual(oldCapabilityCallsAfterOwnerReplacement([call('old-second', 150)], owners, oldTokens, { first: { issuedAt: 100 } }), [call('old-second', 150)]);
});

test('disabled lifecycle 404 classification is bounded by component, host, interval and exact response', () => {
  const componentId = 'pc-target';
  const host = { kind: 'page_block', pageId: 'pg-one', blockId: 'block-one' };
  const windows = [
    { componentId, startedAt: 10, endedAt: 20, host: null },
    { componentId, startedAt: 100, endedAt: 200, host },
  ];
  const owners = new Map([['old-token', { componentId, host, page: 'first' }]]);
  const entry = (overrides = {}) => ({ status: 404, requestStartedAt: 150, method: 'POST', path: '/api/component-capabilities', requestBody: JSON.stringify({ componentId, host }), responseBody: '{"error":{"code":"not_found","message":"Component is disabled"}}', ...overrides });

  assert.equal(isExpectedDisabledComponent404(entry(), componentId, windows, owners), true);
  assert.equal(isExpectedDisabledComponent404(entry({ requestStartedAt: 0, at: 150 }), componentId, windows, owners), true);
  assert.equal(isExpectedDisabledComponent404(entry({ method: 'GET', path: `/api/components/${componentId}`, requestStartedAt: 15, responseBody: '{"error":{"code":"not_found","message":"Component is disabled"}}' }), componentId, windows, owners), true);
  assert.equal(isExpectedDisabledComponent404(entry({ method: 'POST', path: '/api/component-capabilities/old-token', requestBody: '{"method":"read.host"}', responseBody: '{"error":{"code":"not_found","message":"Component capability was revoked"}}' }), componentId, windows, owners), true);
  assert.equal(isExpectedDisabledComponent404(entry({ requestStartedAt: 201 }), componentId, windows, owners), false);
  assert.equal(isExpectedDisabledComponent404(entry({ requestBody: JSON.stringify({ componentId: 'pc-other', host }) }), componentId, windows, owners), false);
  assert.equal(isExpectedDisabledComponent404(entry({ requestBody: JSON.stringify({ componentId, host: { ...host, blockId: 'other-block' } }) }), componentId, windows, owners), false);
  assert.equal(isExpectedDisabledComponent404(entry({ responseBody: '{"error":{"code":"forbidden","message":"Component is disabled"}}' }), componentId, windows, owners), false);
});

test('deleted-component source 404s require a confirmed matching delete and exact not-found response', () => {
  const componentId = 'pc-deleted';
  const deleteResponse = { method: 'DELETE', path: `/api/components/${componentId}`, status: 204, at: 300 };
  const read = { method: 'GET', path: `/api/components/${componentId}`, requestStartedAt: 301, at: 310, status: 404, responseBody: '{"error":{"code":"not_found","message":"Component not found"}}' };
  assert.equal(isExpectedDeletedComponentRead(read, componentId, deleteResponse), true);
  assert.equal(isExpectedDeletedComponentRead({ ...read, requestStartedAt: 0, at: 301 }, componentId, deleteResponse), true);
  assert.equal(isExpectedDeletedComponentRead({ ...read, requestStartedAt: 299 }, componentId, deleteResponse), false);
  assert.equal(isExpectedDeletedComponentRead(read, 'pc-other', deleteResponse), false);
  assert.equal(isExpectedDeletedComponentRead({ ...read, responseBody: '{"error":{"code":"not_found","message":"Component is disabled"}}' }, componentId, deleteResponse), false);
  assert.equal(isExpectedDeletedComponentRead(read, componentId, { ...deleteResponse, status: 500 }), false);
});
