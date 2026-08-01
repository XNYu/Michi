import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import MarkdownContent from './MarkdownContent';

// rehype-katex is loaded lazily (dynamic import in an effect), so assertions
// about rendered math must waitFor the `.katex` output to appear.
describe('MarkdownContent math', () => {
  it('renders block-level $$ math via KaTeX', async () => {
    const { container } = render(<MarkdownContent text={'$$C = \\text{Encoder}(x)$$'} />);
    // KaTeX emits a `.katex` element; survives sanitize because the math-display
    // marker className is allow-listed and katex runs after sanitize.
    await waitFor(() => expect(container.querySelector('.katex')).toBeTruthy());
  });

  it('renders inline $…$ math', async () => {
    const { container } = render(<MarkdownContent text={'the vector $C_i$ encodes context'} />);
    await waitFor(() => expect(container.querySelector('.katex')).toBeTruthy());
    expect(container.textContent).toContain('encodes context');
  });

  it('reverts currency-looking single-$ to text, even after katex loads', async () => {
    // The trailing $x^2$ guarantees katex loads; the price must still survive as text.
    const { container } = render(<MarkdownContent text={'it costs $5 to $10 total, see $x^2$'} />);
    await waitFor(() => expect(container.querySelectorAll('.katex')).toHaveLength(1));
    expect(container.textContent).toContain('$5 to $10 total');
  });

  it('reverts leaked ${…} template interpolations to text, not math', async () => {
    // Two `$` from a JS template literal pair up in remark-math; the trailing
    // $x^2$ guarantees katex loads, and the interpolation must survive as text.
    const { container } = render(
      <MarkdownContent text={'use ${API_BASE_URL}/workspaces/${id}/watch/stream, see $x^2$'} />,
    );
    await waitFor(() => expect(container.querySelectorAll('.katex')).toHaveLength(1));
    expect(container.textContent).toContain('${API_BASE_URL}/workspaces/${id}/watch/stream');
  });

  it('leaves real inline math that opens with an escaped group untouched', async () => {
    const { container } = render(<MarkdownContent text={'the set $\\{a,b\\}$ is small'} />);
    await waitFor(() => expect(container.querySelector('.katex')).toBeTruthy());
    expect(container.textContent).toContain('is small');
  });

  it('keeps math intact under tail-reveal streaming', async () => {
    const { container } = render(
      <MarkdownContent text={'$$E = mc^2$$'} revealTailChars={8} />,
    );
    await waitFor(() => expect(container.querySelector('.katex')).toBeTruthy());
    const katex = container.querySelector('.katex')!;
    // reveal must not inject its per-char spans inside katex output
    expect(katex.querySelector('.stream-token-reveal')).toBeNull();
  });
});
