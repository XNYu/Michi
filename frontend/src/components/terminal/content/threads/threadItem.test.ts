import { describe, expect, it } from 'vitest';
import { isEditableTarget } from './threadItem';

const input = (type: string) => Object.assign(document.createElement('input'), { type });

describe('isEditableTarget', () => {
  it('treats text fields and radios as editable, so they keep their own Esc and arrows', () => {
    for (const type of ['text', 'search', 'number', 'date', 'range', 'radio']) expect(isEditableTarget(input(type))).toBe(true);
    expect(isEditableTarget(document.createElement('textarea'))).toBe(true);
    expect(isEditableTarget(document.createElement('select'))).toBe(true);
  });

  it('does not treat a checkbox or button-like input as a text field', () => {
    for (const type of ['checkbox', 'button', 'submit', 'reset']) expect(isEditableTarget(input(type))).toBe(false);
    expect(isEditableTarget(document.createElement('button'))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});
