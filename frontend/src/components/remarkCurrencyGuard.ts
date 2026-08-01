/**
 * remark-math parses `$…$` greedily, so non-math prose can be captured as an
 * inlineMath node. This transformer runs *after* remark-math and reverts
 * inlineMath nodes that are false positives back to literal `$…$` text. It
 * guards two classes common in this app:
 *
 *  1. Currency — "$5 to $10" becomes inlineMath "5 to ": the value starts with
 *     a digit and contains no LaTeX command characters (`\ ^ _ { }`).
 *  2. Template / shell interpolation — "${API_BASE_URL}/x/${id}" becomes
 *     inlineMath "{API_BASE_URL}/x/": remark-math ate the opening `$`, leaving
 *     a value that starts with an unescaped `{identifier}` group and has no `\`
 *     command chars. Real inline LaTeX opening a group escapes it (`$\{a\}$`),
 *     so this stays high-precision.
 *
 * Real inline math such as `$x_i$`, `$2\pi$`, or `$\{a,b\}$` is left untouched.
 */

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
}

const LATEX_CHARS = /[\\^_{}]/;
const STARTS_WITH_DIGIT = /^\s*\d/;
// A `${…}` template literal / `${VAR}` shell expansion whose leading `$` was
// consumed by remark-math: the value opens with `{identifier}` (letters,
// digits, `_`, `$`, and member `.`). Bare LaTeX never opens with a literal `{`.
const TEMPLATE_INTERPOLATION = /^\{[\w$][\w$.]*\}/;

function looksLikeCurrency(value: string): boolean {
  return STARTS_WITH_DIGIT.test(value) && !LATEX_CHARS.test(value);
}

function looksLikeTemplateInterpolation(value: string): boolean {
  return value.startsWith('{') && !value.includes('\\') && TEMPLATE_INTERPOLATION.test(value);
}

function isMathFalsePositive(value: string): boolean {
  return looksLikeCurrency(value) || looksLikeTemplateInterpolation(value);
}

function walk(node: MdastNode): void {
  if (!Array.isArray(node.children)) return;
  node.children = node.children.map((child) => {
    if (child.type === 'inlineMath' && typeof child.value === 'string' && isMathFalsePositive(child.value)) {
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
