// ESLint flat config (ESM). See README.md "Contract" section for the
// architectural rules this file enforces.
import js from '@eslint/js';
import globals from 'globals';
import eslintConfigPrettier from 'eslint-config-prettier';

export default [
  // Global ignores. Pre-modernization code and vendored client libraries
  // are being deleted/rewritten wholesale by later work packages (see
  // /root/.claude/plans — P1a, P1e, P2, P3a); linting them is pure noise
  // over code that won't exist by the time this migration is done. Each
  // entry here is removed by the same work package that deletes the
  // corresponding files, not before.
  {
    ignores: [
      'coverage/**',
      'lib/**', // deleted by P1a (exchange.js, BinaryHeap.js) + P1e (db.js) + P2 (nocklib.js)
      'routes/**', // deleted by P2
      'nockmarket.js', // deleted by P2
      'public/lib/**', // vendored jquery/backbone/underscore/bootstrap, deleted by P3a
      'public/templates/**', // Underscore-compiled template, deleted by P3a
      'public/js/**', // rewritten in place (vanilla ESM) by P3a; current files use jQuery/Backbone/Underscore globals this config intentionally does not define
      'test/db.test.js', // superseded by P1e's test/db/**
      'test/exchange.test.js', // superseded by P1a's test/order-book/**
    ],
  },

  js.configs.recommended,

  // Default parser options for all JS in the repo.
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
    },
  },

  // Server-side source and tests run under Node.
  {
    files: ['src/**/*.js', 'test/**/*.js', 'scripts/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },

  // Browser-side client code. No jQuery/Backbone/Underscore globals here —
  // that stack is gone. `io` is the global exposed by the socket.io client
  // script tag.
  {
    files: ['public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        io: 'readonly',
      },
    },
  },

  // Architectural boundary: src/order-book/** must be a self-contained,
  // extractable unit. It may import nothing outside its own directory —
  // no relative escapes, no bare package specifiers (including node:
  // builtins). Consumers reach it only through src/order-book/index.js.
  //
  // Regex patterns, not gitignore-style `group` globs: a `group` glob
  // with no slash in it (e.g. `'*'`) is implicitly anchored as `**/*` and
  // matches at any depth — including same-directory relative imports
  // like `./order-book.js`, which must stay allowed. Regex gives exact
  // control over the string's start instead.
  {
    files: ['src/order-book/**/*.js'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^\\.\\./',
              message:
                'src/order-book/** may not import outside its own directory (extraction boundary).',
            },
            {
              regex: '^(?!\\.{1,2}/)',
              message:
                'src/order-book/** may not import bare package specifiers (extraction boundary). ' +
                'It must have zero dependencies, including node builtins, to stay a drop-in package.',
            },
          ],
        },
      ],
    },
  },

  // Prettier config must be last: it disables stylistic rules that would
  // otherwise conflict with `npm run format`.
  eslintConfigPrettier,
];
