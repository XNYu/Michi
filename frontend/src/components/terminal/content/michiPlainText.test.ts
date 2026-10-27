import { describe, expect, it } from 'vitest';
import { michiOneLine, michiSameText } from './michiPlainText';

describe('michiOneLine', () => {
  it('drops Markdown syntax and keeps what it marked up', () => {
    expect(michiOneLine('**EXAMPLE-123（示例文档）**：Needs revision。合入前补齐示例说明'))
      .toBe('EXAMPLE-123（示例文档）：Needs revision。合入前补齐示例说明');
    expect(michiOneLine('## 一、结论：部分完成，示例页面仍需调整')).toBe('一、结论：部分完成，示例页面仍需调整');
    expect(michiOneLine("`0123456789abcdef` ✅ Implement the 'ui' part")).toBe("0123456789abcdef ✅ Implement the 'ui' part");
    expect(michiOneLine('See [the PR](https://example.com/pr/1) and ![shot](https://x/y.png)')).toBe('See the PR and shot');
    expect(michiOneLine('> quoted\n> > nested')).toBe('quoted nested');
    expect(michiOneLine('- [x] done\n- todo\n1. first')).toBe('done todo first');
    expect(michiOneLine('*italic* and _also_ and ~~gone~~ and __bold__')).toBe('italic and also and gone and bold');
    expect(michiOneLine('```ts\nconst a = 1;\n```')).toBe('const a = 1;');
    expect(michiOneLine('| ExampleValidationError | Example table |\n|---|---|\n| server | 409 |')).toBe('ExampleValidationError · Example table server · 409');
    expect(michiOneLine('line one\n\nline   two')).toBe('line one line two');
  });

  it('keeps a link or image address after its text when asked, exactly as written', () => {
    const text = 'See [the PR](https://e.example/pr_1_/*x*) and ![shot](https://x/y_z_.png) or [https://a](https://a)';
    expect(michiOneLine(text, { linkUrls: true })).toBe('See the PR (https://e.example/pr_1_/*x*) and shot (https://x/y_z_.png) or https://a');
    expect(michiOneLine(text)).toBe('See the PR and shot or https://a');
  });

  it('leaves symbols that are only text alone', () => {
    expect(michiOneLine('C# and F# beat a > b')).toBe('C# and F# beat a > b');
    expect(michiOneLine('2*3*4 = 24, x * y')).toBe('2*3*4 = 24, x * y');
    expect(michiOneLine('rename snake_case_name to my__dunder__name')).toBe('rename snake_case_name to my__dunder__name');
    expect(michiOneLine('-5 degrees, 3.14')).toBe('-5 degrees, 3.14');
    expect(michiOneLine('escaped \\*stars\\*')).toBe('escaped *stars*');
  });

  it('keeps code exactly as written, inline or fenced', () => {
    expect(michiOneLine('Edit `__init__.py` first')).toBe('Edit __init__.py first');
    expect(michiOneLine('Write `[x](y)` for a link')).toBe('Write [x](y) for a link');
    expect(michiOneLine('Rename `_private_` and ``a**2 + b**2``')).toBe('Rename _private_ and a**2 + b**2');
    expect(michiOneLine('**Run** `# not a heading` and `~~x~~`')).toBe('Run # not a heading and ~~x~~');
    expect(michiOneLine('```py\n# __init__.py\n- [a](b)\n```\nthen **ship**')).toBe('# __init__.py - [a](b) then ship');
    expect(michiOneLine('```\nunclosed __dunder__')).toBe('unclosed __dunder__');
  });

  it('never pairs a stray backtick across a fenced block, and puts every held piece back', () => {
    // A stray backtick a cut explains goes (see below): the last one, opening.
    expect(michiOneLine('Run `npm test\n```\nlog\n```\nthen `done`')).toBe('Run npm test log then done');
    // One no cut explains (an opening first, a closing last) is a literal backtick, as CommonMark reads it.
    expect(michiOneLine('`a\n```\n__x__\n```\nb`')).toBe('`a __x__ b`');
    expect(michiOneLine('Run `npm test\n```\nlog\n```\nthen `done`')).not.toMatch(/\uE000|\uE001/);
    // Text that happens to hold the placeholder's own characters comes back as it was.
    expect(michiOneLine('```\n\uE0000\uE001\n```')).toBe('\uE0000\uE001');
  });

  it('drops an emphasis or code mark whose other half Michi cut off, and only such a mark', () => {
    expect(michiOneLine('截至示例日期，我的判断是：**composable')).toBe('截至示例日期，我的判断是：composable');
    expect(michiOneLine('I built it from a clean copy of commit `')).toBe('I built it from a clean copy of commit');
    expect(michiOneLine('commit `abcdef12…')).toBe('commit abcdef12…');
    expect(michiOneLine('ing tests** and then the fixtures')).toBe('ing tests and then the fixtures');
    expect(michiOneLine('**Done:** shipped it. **Next')).toBe('Done: shipped it. Next');
    expect(michiOneLine('~~the old plan')).toBe('the old plan');
    expect(michiOneLine('and done** then **next one')).toBe('and done then next one');
    // Marks that are just text stay: inside a word, standing alone, or paired.
    expect(michiOneLine('2 ** 3 is a**b, and ` alone')).toBe('2 ** 3 is a**b, and ` alone');
    expect(michiOneLine('**bold** and `code`')).toBe('bold and code');
  });

  it('leaves code written without backticks alone: only a mark at a cut goes', () => {
    expect(michiOneLine('src/**/*.test.ts')).toBe('src/**/*.test.ts');
    expect(michiOneLine('run every src/**/*.test.ts file')).toBe('run every src/**/*.test.ts file');
    expect(michiOneLine('func(**kwargs)')).toBe('func(**kwargs)');
    expect(michiOneLine('call func(**kwargs) with the options')).toBe('call func(**kwargs) with the options');
    expect(michiOneLine('int **pp;')).toBe('int **pp;');
    expect(michiOneLine('declared int **pp = NULL; then freed it.')).toBe('declared int **pp = NULL; then freed it.');
    expect(michiOneLine('__dirname')).toBe('__dirname');
    expect(michiOneLine('it uses __dirname to find the build')).toBe('it uses __dirname to find the build');
    expect(michiOneLine('__init done')).toBe('__init done');
    // Only the first leftover may be a cut closing, only the last a cut opening.
    expect(michiOneLine('a ** b and c** d')).toBe('a ** b and c** d');
    expect(michiOneLine('**one and **two')).toBe('**one and two');
    // A text that ends a sentence wasn't cut at its end.
    expect(michiOneLine('Ship **this.')).toBe('Ship **this.');
    expect(michiOneLine('Ship **this...')).toBe('Ship this...');
  });

  it('reads text cut open inside a code span as code, never gluing words', () => {
    // Michi's excerpt starts inside a span: its first backtick closes it.
    expect(michiOneLine("y(() => import('./pages/X'))` at L38. Settings is `<SettingsDrawer>` (L779), which is `DrawerShell` with `title=\"Settings\"`. **Order** of"))
      .toBe("y(() => import('./pages/X')) at L38. Settings is <SettingsDrawer> (L779), which is DrawerShell with title=\"Settings\". Order of");
    expect(michiOneLine('a__b` then **ship**')).toBe('a__b then ship');
    // Space inside a span still parts it from the words around it.
    expect(michiOneLine('x`, which is `y')).toBe('x, which is y');
    // An opening span that just runs past the end is not a cut start.
    expect(michiOneLine('Run `npm test')).toBe('Run npm test');
  });

  it('keeps a fenced block inside a quote as code', () => {
    expect(michiOneLine('> ```py\n> __init__.py\n> ```\n> then **ship**')).toBe('__init__.py then ship');
  });
});

describe('michiSameText', () => {
  it('matches text that says the same thing', () => {
    expect(michiSameText('同步 Michi 提交到公开镜像', '同步 Michi 提交到公开镜像')).toBe(true);
    expect(michiSameText('**Ship** the  release.', 'ship the release')).toBe(true);
    expect(michiSameText('Ship the release', 'Ship the release notes')).toBe(false);
    expect(michiSameText('', '')).toBe(false);
  });
});
