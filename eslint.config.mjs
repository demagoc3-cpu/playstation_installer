import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import prettier from 'eslint-config-prettier/flat';
import * as vueRuntime from 'vue';

const autoImports = Object.fromEntries(
  [
    ...Object.keys(vueRuntime),
    '$fetch',
    'useAppLocale',
    'useConsoleRequest',
    'useRuntimeConfig',
    'useState',
    'useHead',
    'useCookie',
    'useFetch',
    'useGamePreview',
    'defineNuxtConfig',
    'defineNuxtPlugin',
  ].map((name) => [name, 'readonly']),
);

export default [
  {
    ignores: [
      '**/node_modules/**',
      '.nuxt/**',
      '.output/**',
      '.nitro/**',
      '.data/**',
      '.cache/**',
      '.toolchains/**',
      'tooling/**',
      'dist/**',
      'output/**',
      'build/**',
      'coverage/**',
      'PackegeFlowService/**',
      'prowlarr/**',
      '**/bin/**',
      '**/obj/**',
      'docs/**',
      'packaging/windows/**',
      'apps/windows-launcher/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/essential'],
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx,jsx,vue}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  { files: ['app/**/*.{ts,js,vue}', 'nuxt.config.ts'], languageOptions: { globals: autoImports } },
  {
    files: ['**/*.vue'],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
    // Template consumers are not visible to ESLint 10's assignment analysis.
    rules: { 'no-useless-assignment': 'off' },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-expressions': [
        'error',
        { allowShortCircuit: true, allowTernary: true },
      ],
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  // These input validators deliberately reject ASCII control characters.
  {
    files: [
      'server/utils/console-files.ts',
      'server/utils/console-profiles.ts',
      'server/utils/presets.ts',
      'server/utils/ps4-saves.ts',
      'server/utils/ps4-service-installer.ts',
      'server/utils/ps5-content-metadata.ts',
      'server/utils/ps5-folder-driver.ts',
      'server/utils/ps5-management.ts',
      'server/utils/save-backup-store.ts',
      'server/utils/save-set-import.ts',
      'server/utils/save-set-store.ts',
      'server/utils/search-browser-session.ts',
      'server/utils/storage-connector.ts',
      'server/utils/storage-sources.ts',
    ],
    rules: { 'no-control-regex': 'off' },
  },
  prettier,
];
