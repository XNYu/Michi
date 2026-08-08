export interface MarkdownFixture {
  id: string;
  label: string;
  markdown: string;
}

function proseFixture(): string {
  return Array.from({ length: 28 }, (_, index) => [
    `## Observation ${index + 1}: 流式渲染与结构稳定性`,
    '',
    `Michi needs to keep **already committed prose** stable while the latest sentence grows. 第 ${index + 1} 段包含中文、English words、*emphasis*、~~strikethrough~~、\`inline code\`，以及一个 [reference link](https://example.com/docs/${index + 1}).`,
    '',
    `A useful renderer should minimize repeated work, preserve selection, and avoid blocking input. The payload also contains punctuation：逗号，句号。问号？以及 CJK 与 Latin 之间的边界。`,
  ].join('\n')).join('\n\n');
}

function gfmFixture(): string {
  return Array.from({ length: 10 }, (_, section) => {
    const rows = Array.from({ length: 6 }, (_, row) =>
      `| item-${section + 1}-${row + 1} | ${row % 2 === 0 ? '**ready**' : '*pending*'} | ${17 + section * 3 + row} ms |`,
    );
    return [
      `## GFM section ${section + 1}`,
      '',
      '- [x] Parse headings and paragraphs',
      '- [ ] Reconcile the growing final block',
      `  - nested item with [link](https://example.com/gfm/${section + 1})`,
      '  - nested item with `code` and ~~deleted text~~',
      '',
      '> Streaming tables are interesting because a delimiter row can reinterpret the line above it.',
      '> The block quote deliberately spans multiple lines.',
      '',
      '| Name | Status | Cost |',
      '| :--- | :---: | ---: |',
      ...rows,
    ].join('\n');
  }).join('\n\n---\n\n');
}

function codeFixture(): string {
  return Array.from({ length: 8 }, (_, block) => {
    const tsLines = Array.from({ length: 34 }, (_, line) =>
      `  const value${line} = input.items[${line}]?.map((item) => item.score * ${block + 1}) ?? [];`,
    );
    return [
      `## TypeScript pipeline ${block + 1}`,
      '',
      '```ts',
      `export function transform${block}(input: Payload): Result {`,
      `  const benchmarkVariant = '__BENCH_VARIANT__';`,
      ...tsLines,
      `  return { id: 'block-${block}', values: value${block} };`,
      '}',
      '```',
      '',
      '```json',
      JSON.stringify({ block, enabled: true, tags: ['streaming', 'markdown', 'benchmark'], threshold: 0.75 }, null, 2),
      '```',
      '',
      `The code fence above is repeatedly incomplete while chunk ${block + 1} arrives.`,
    ].join('\n');
  }).join('\n\n');
}

function mathHtmlFixture(): string {
  return Array.from({ length: 18 }, (_, index) => [
    `## Formula and HTML ${index + 1}`,
    '',
    `Inline math: $E_${index} = mc^2 + \\alpha_${index}$, while currency such as $5 to $10 should remain prose in Michi.`,
    '',
    '$$',
    `\\sum_{i=1}^{${index + 3}} i^2 = \\frac{n(n+1)(2n+1)}{6}`,
    '$$',
    '',
    `<details><summary>Raw HTML ${index + 1}</summary><p>Safe <strong>nested markup</strong> with <a href="https://example.com/html/${index + 1}">a link</a>.</p></details>`,
  ].join('\n')).join('\n\n');
}

function footnoteFixture(): string {
  const body = Array.from({ length: 34 }, (_, index) => [
    `### Long-document note ${index + 1}`,
    '',
    `This paragraph references shared context[^shared] and a local note[^note-${index + 1}]. The footnote syntax intentionally forces conservative whole-document block handling.`,
    '',
    `追加内容 ${index + 1}：当文档持续增长时，解析器需要在正确性、语义延迟和主线程预算之间做选择。`,
  ].join('\n')).join('\n\n');
  const notes = [
    '[^shared]: Shared footnote used throughout the document.',
    ...Array.from({ length: 34 }, (_, index) => `[^note-${index + 1}]: Footnote payload ${index + 1} with **formatting** and a URL https://example.com/note/${index + 1}.`),
  ].join('\n');
  return `${body}\n\n${notes}`;
}

function featureParityFixture(): string {
  const sections = Array.from({ length: 4 }, (_, section) => {
    const codeLines = Array.from(
      { length: 12 },
      (_, line) => `const feature${section}_${line} = ${section + line} * 2;`,
    );
    const tableRows = Array.from(
      { length: 5 },
      (_, row) => `| feature-${section + 1}-${row + 1} | **ready。**继续 | ${row + 1} |`,
    );
    return [
      `## Full feature section ${section + 1}`,
      '',
      '**该强调包含句号。**这是紧邻的后文，~~该删除线包含句号。~~这也是后文。',
      '',
      'مرحبا بالعالم — هذا السطر يختبر اتجاه النص من اليمين إلى اليسار.',
      '',
      `Open [the external reference](https://example.com/feature/${section + 1}) and review the controls.`,
      '',
      '| Feature | CJK status | Count |',
      '| :--- | :---: | ---: |',
      ...tableRows,
      '',
      '```ts',
      `const benchmarkVariant = '__BENCH_VARIANT__';`,
      ...codeLines,
      '```',
      '',
      '```mermaid',
      'flowchart LR',
      `  Input${section}__BENCH_VARIANT__ --> Parse${section}`,
      `  Parse${section} --> Render${section}`,
      `  Render${section} --> Done${section}`,
      '```',
    ].join('\n');
  });

  return [
    '<div>',
    '    <strong>Indented HTML normalization</strong>',
    '</div>',
    '',
    ...sections,
  ].join('\n\n');
}

export const fixtures: MarkdownFixture[] = [
  { id: 'prose-cjk', label: 'Prose + CJK', markdown: proseFixture() },
  { id: 'gfm-structure', label: 'GFM structure', markdown: gfmFixture() },
  { id: 'code-heavy', label: 'Code-heavy', markdown: codeFixture() },
  { id: 'math-html', label: 'Math + raw HTML', markdown: mathHtmlFixture() },
  { id: 'footnotes-long', label: 'Long footnotes', markdown: footnoteFixture() },
  { id: 'feature-parity', label: 'Full feature parity', markdown: featureParityFixture() },
];
