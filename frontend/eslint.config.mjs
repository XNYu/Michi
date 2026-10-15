import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      // The bug we're guarding against: a useEffect referenced `streaming`
      // before its `const streaming = ...` declaration further down the same
      // function. tsc didn't catch it; ESLint does.
      'no-use-before-define': 'off',
      // warn (not error) — chatStore has safe forward references inside
      // async callbacks that the rule can't distinguish from a real TDZ.
      // We still want the warning surfaced so reviewers see it on new code.
      '@typescript-eslint/no-use-before-define': [
        'warn',
        {
          functions: false,
          classes: false,
          variables: true,
          enums: true,
          typedefs: false,
          ignoreTypeReferences: true,
        },
      ],
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Looser defaults — we just want the safety nets, not a full lint pass.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
    },
  },
  {
    // Design tokens: inline styles must use the scales in index.css :root, not
    // literals, or the type/radius/motion/colour systems drift apart again.
    files: ['src/**/*.tsx'],
    ignores: ['src/**/*.test.tsx'],
    rules: {
      'no-restricted-syntax': [
        'warn',
        {
          selector: "Property[key.name='fontSize'] > Literal[value>0]",
          message: "Use a type-scale token, e.g. fontSize: 'var(--fs-sm)' (index.css :root).",
        },
        {
          selector: "Property[key.name='letterSpacing'] > Literal[value=/em$/]",
          message: "Use a tracking token, e.g. letterSpacing: 'var(--ls-caps-wide)'.",
        },
        {
          selector: "Property[key.name='borderRadius'] > Literal[value>0]",
          message: "Use a radius token: 'var(--ui-radius-sm)', 'var(--ui-radius)', 'var(--ui-radius-lg)' or 'var(--ui-radius-pill)'.",
        },
        {
          // 1–6 order siblings inside one component; anything that layers over
          // a pane or the page takes a rung (index.css :root z ladder).
          selector: "Property[key.name='zIndex'] > Literal[value>=7]",
          message: "Use a z-index rung, e.g. zIndex: 'var(--z-pane-overlay)' or 'var(--z-popover)'.",
        },
        {
          selector: "Property[key.name=/^(transition|animation)$/] Literal[value=/\\d(ms|s)\\b/]",
          message: "Use a motion token: var(--t-quick|soft|enter|decay|slow) or var(--t-loop-fast|loop|loop-slow).",
        },
        {
          selector: "Property > Literal[value=/^#[0-9a-fA-F]{3,8}$/]",
          message: "Use a palette token, e.g. 'var(--term-fg)', not a hex colour.",
        },
      ],
    },
  },
);
