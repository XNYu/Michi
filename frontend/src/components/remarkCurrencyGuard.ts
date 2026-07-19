/**
 * remark-math parses `$…$` greedily, so prose like "$5 to $10" becomes an
 * inlineMath node ("5 to "). This transformer runs *after* remark-math and
 * reverts inlineMath nodes that look like currency rather than math:
 * the content starts with a digit and contains no LaTeX command characters
 * (`\ ^ _ {`). Real inline math such as `$x_i$` or `$2\pi$` is left untouched.
 */

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
}

const LATEX_CHARS = /[\\^_{}]/;
const STARTS_WITH_DIGIT = /^\s*\d/;

function looksLikeCurrency(value: string): boolean {
  return STARTS_WITH_DIGIT.test(value) && !LATEX_CHARS.test(value);
}

function walk(node: MdastNode): void {
  if (!Array.isArray(node.children)) return;
  node.children = node.children.map((child) => {
    if (child.type === 'inlineMath' && typeof child.value === 'string' && looksLikeCurrency(child.value)) {
      return { type: 'text', value: `$${child.value}$` };
    }
    walk(child);
    return child;
  });
}

export function remarkCurrencyGuard() {
  return function transform(tree: MdastNode) {
    walk(tree);
  };
}
