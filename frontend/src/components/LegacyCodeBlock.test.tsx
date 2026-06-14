import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import LegacyCodeBlock from './LegacyCodeBlock';

// `deferHighlight` skips the lazy Shiki import so these render synchronously
// (plain lines) — we're asserting chrome, not token coloring.
describe('LegacyCodeBlock chrome', () => {
  it('renders the language label and the copy button', () => {
    const { container } = render(
      <LegacyCodeBlock text={'a\nb\nc'} language="bash" deferHighlight />,
    );
    expect(container.querySelector('.michi-code-language')?.textContent).toBe('bash');
    expect(container.querySelector('.michi-code-copy')).not.toBeNull();
  });

  it('falls back to "text" when no language is provided', () => {
    const { container } = render(<LegacyCodeBlock text={'x\ny'} deferHighlight />);
    expect(container.querySelector('.michi-code-language')?.textContent).toBe('text');
  });
});
