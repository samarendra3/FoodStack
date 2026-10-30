import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import prettier from 'eslint-config-prettier';

/** ESLint flat config for FoodStack Next.js apps. */
export const next = [
  { ignores: ['.next/**', 'next-env.d.ts', 'dist/**'] },
  ...nextVitals,
  ...nextTs,
  prettier,
];

export default next;
