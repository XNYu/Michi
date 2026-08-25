import assert from 'node:assert/strict';
import test from 'node:test';
import { isClosePaneShortcut } from '../electron/dist/paneShortcuts.js';

function input(overrides = {}) {
  return {
    type: 'keyDown',
    key: 'w',
    meta: false,
    control: false,
    shift: false,
    alt: false,
    ...overrides,
  };
}

test('matches the platform close-pane accelerator', () => {
  assert.equal(isClosePaneShortcut(input({ meta: true }), 'darwin'), true);
  assert.equal(isClosePaneShortcut(input({ control: true }), 'linux'), true);
  assert.equal(isClosePaneShortcut(input({ control: true }), 'win32'), true);
});

test('does not steal close-window or alternate modified shortcuts', () => {
  assert.equal(isClosePaneShortcut(input({ meta: true, shift: true }), 'darwin'), false);
  assert.equal(isClosePaneShortcut(input({ meta: true, alt: true }), 'darwin'), false);
  assert.equal(isClosePaneShortcut(input({ meta: true, control: true }), 'darwin'), false);
});

test('ignores key-up and non-W input', () => {
  assert.equal(isClosePaneShortcut(input({ type: 'keyUp', meta: true }), 'darwin'), false);
  assert.equal(isClosePaneShortcut(input({ key: 'q', meta: true }), 'darwin'), false);
});
