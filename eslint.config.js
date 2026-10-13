// Lint rules for the whole repo. Type-aware rules catch what the compiler lets
// through: promises nobody awaits or that reject where nothing listens, `any`
// leaking out of JSON and SQL rows, template strings that print [object Object],
// and React hooks used in ways that break later.
//   npm run lint

import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import react from 'eslint-plugin-react'
import globals from 'globals'

export default tseslint.config(
  // ops/seed/shop is the sample app the forge setup pushes, not this codebase.
  { ignores: ['node_modules/', 'app/dist/', 'research/', 'docs/', '.scratch/', 'test/ui-shots/', 'eslint.config.js', 'ops/seed/', '.claude/worktrees/'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      eqeqeq: 'error',
      'no-console': 'off',
      // Numbers and booleans read fine in a template string. Objects do not.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      // Naming a field in a destructure to leave it out of `...rest` is how this code drops fields.
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
      // Style rules from the strict set, left off. The coding-standards skill says why.
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-dynamic-delete': 'off',
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
    },
  },
  {
    files: ['server/**/*.ts', 'daemon/**/*.ts', 'shared/**/*.ts', 'ops/**/*.ts', 'pipelines/**/*.ts', 'test/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['app/src/**/*.{ts,tsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: { globals: globals.browser },
    settings: { react: { version: 'detect' } },
    rules: {
      ...reactHooks.configs['recommended-latest'].rules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      'react/jsx-key': 'error',
      'react/no-danger': 'error',
      'react/jsx-no-target-blank': 'error',
      'react/no-unstable-nested-components': 'error',
      'react/jsx-no-constructed-context-values': 'error',
      'react/no-direct-mutation-state': 'error',
      'react/button-has-type': 'error',
    },
  },
  // Checks read rows of many shapes from Postgres. Their asserts catch a wrong
  // shape, so they may treat rows loosely.
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  // The Electron main file is plain CommonJS with no types to check.
  {
    files: ['desktop/**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { ...tseslint.configs.disableTypeChecked.languageOptions, globals: globals.node, sourceType: 'commonjs' },
    // CommonJS loads modules with require; that is the point of a .cjs file.
    rules: { ...tseslint.configs.disableTypeChecked.rules, '@typescript-eslint/no-require-imports': 'off' },
  },
)
