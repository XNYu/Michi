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
);
