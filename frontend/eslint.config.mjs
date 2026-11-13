import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import importPlugin from 'eslint-plugin-import';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import { defineConfig, globalIgnores } from 'eslint/config';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // eslint-config-next already registers the `import` plugin; reuse it and
  // only turn on the rules from `plugin:import/recommended`.
  { rules: importPlugin.flatConfigs.recommended.rules },
  {
    // Vendored shadcn registry components (`pnpm shadcn:install` overwrites
    // them) trip the React Compiler rules that eslint-plugin-react-hooks v7
    // enables via eslint-config-next 16. Report them as warnings here rather
    // than patching code that is regenerated from upstream.
    files: ['components/agents-ui/**', 'components/ai-elements/**', 'hooks/agents-ui/**'],
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/static-components': 'warn',
    },
  },
  prettierRecommended,
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts']),
]);

export default eslintConfig;
