import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['node_modules', '../caduceus/web_dist', 'playwright-report', 'test-results'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      // WPT-6: single escape path — raw HTML injection is banned outright.
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'dangerouslySetInnerHTML is banned (WPT-6)',
        },
      ],
    },
  },
  {
    // WPT-1: src/lib is a pure zone — no React, no DOM APIs, no app layers.
    files: ['src/lib/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['react', 'react-*'], message: 'src/lib must stay framework-free (WPT-1)' },
            { group: ['../api/*', '../state/*', '../components/*', '../pages/*'], message: 'src/lib imports nothing from the app (WPT-1)' },
          ],
        },
      ],
      'no-restricted-globals': ['error', 'fetch', 'WebSocket', 'document', 'window', 'localStorage'],
    },
  },
)
