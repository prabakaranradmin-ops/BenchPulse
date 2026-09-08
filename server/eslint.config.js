// ESLint 9 flat config. Type-aware linting is on: most of what's worth catching in this
// codebase (a forgotten await on a store call, an unchecked null from a `... | null` return)
// is invisible to syntax-only rules.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'migrations/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Unused args are often there for signature clarity (Fastify handlers, hook params);
      // a leading underscore is the opt-out.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Floating promises are the bug class this config exists to catch: an un-awaited store
      // write looks fine and silently loses data.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // Off deliberately: nearly every `async` here is dictated by a contract rather than by
      // the body. memoryStore implements the async TrailStore interface, and Fastify requires
      // async plugin/handler signatures. Flagging those trains people to ignore the linter.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // The config file isn't part of tsconfig's program, so type-aware rules can't parse it.
    files: ['eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // Row mappers unavoidably start from `any` (pg returns untyped rows) and the tests reach
    // into JSON response bodies. Both are checked at the boundary instead.
    files: ['src/db/postgresStore.ts', '**/*.test.ts', 'src/testSupport/**'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
  {
    // Jobs are CLI entry points: top-level await and console output are the interface.
    files: ['src/jobs/**', 'src/index.ts'],
    rules: { 'no-console': 'off' },
  },
  prettierConfig,
);
