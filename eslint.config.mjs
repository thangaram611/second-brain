// Flat ESLint config for the whole monorepo. Non-type-checked typescript-eslint
// recommended rules — fast, no project graph needed. `pnpm lint` runs this per
// package via turbo (each package's `lint` script is `eslint .`); ESLint
// resolves this root config by walking up from the package dir.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    // Never lint build output, deps, coverage, turbo cache, or config files.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/*.config.{js,mjs,cjs,ts,mts}',
      'apps/ui/dist/**',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // Honor the `_`-prefix convention for deliberately-unused bindings
      // (signature placeholders, ignored destructure slots, caught errors).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // Browser globals for the React UI.
    files: ['apps/ui/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    // Tests touch internals and stub shapes; `any` is pragmatic there.
    files: ['**/*.{test,spec}.{ts,tsx}', '**/__tests__/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
