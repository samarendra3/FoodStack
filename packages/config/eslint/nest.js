import globals from 'globals';
import tseslint from 'typescript-eslint';
import { base } from './base.js';

/** ESLint flat config for the NestJS API (decorator-heavy, Node globals). */
export const nest = tseslint.config(...base, {
  languageOptions: { globals: { ...globals.node, ...globals.jest } },
  rules: {
    // Nest DI needs runtime class imports for constructor injection metadata.
    '@typescript-eslint/consistent-type-imports': 'off',
    '@typescript-eslint/no-extraneous-class': 'off',
  },
});

export default nest;
