import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MichiTag, type MichiTagVariant } from './MichiTag';

const VARIANTS: MichiTagVariant[] = ['new', 'agent-says', 'you-edited', 'back-after-archive', 'ignored'];

describe('MichiTag', () => {
  it.each<[MichiTagVariant, string]>([
    ['new', 'NEW'],
    ['agent-says', 'Agent says'],
    ['you-edited', 'You edited'],
    ['back-after-archive', 'Back after archive'],
    ['ignored', 'ignored'],
  ])('labels the %s variant "%s" by default', (variant, text) => {
    render(<MichiTag variant={variant} />);
    const tag = screen.getByText(text);
    expect(tag.className).toBe('michi-tag');
    expect(tag.getAttribute('data-variant')).toBe(variant);
  });

  it('takes its own text and an id for aria-describedby', () => {
    render(<MichiTag variant="new" id="t1">New</MichiTag>);
    expect(screen.getByText('New').id).toBe('t1');
  });

  it('keeps every variant apart when they sit side by side', () => {
    const { container } = render(<>{VARIANTS.map((v) => <MichiTag key={v} variant={v} title={`tag ${v}`} />)}</>);
    const tags = Array.from(container.querySelectorAll('.michi-tag'));
    expect(tags.map((t) => t.getAttribute('data-variant'))).toEqual(VARIANTS);
    expect(tags.map((t) => t.getAttribute('title'))).toEqual(VARIANTS.map((v) => `tag ${v}`));
  });
});
