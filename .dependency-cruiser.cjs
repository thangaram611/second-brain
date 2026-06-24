/**
 * Architecture boundary rules for the second-brain monorepo.
 *
 * Layering (enforced as error-severity forbidden rules):
 *   - apps/ui talks to the server over REST only — it imports no @second-brain/*
 *     package and never reaches into apps/server or apps/relay.
 *   - packages/core depends only on packages/types.
 *   - packages/types is a leaf — it imports no other workspace package.
 *   - apps/relay depends only on packages/types.
 *   - packages never import apps.
 *   - no circular dependencies.
 *
 * Cross-package `@second-brain/*` imports are resolved to TypeScript SOURCE under
 * packages/<x>/src (via tsconfig.depcruise.json path mappings + tsPreCompilationDeps),
 * so the path anchors below key on `(^|/)packages/<x>/` / `(^|/)apps/<x>/` to match
 * the resolved real path regardless of where the run is anchored.
 */
module.exports = {
  forbidden: [
    {
      name: 'ui-no-server',
      comment: 'apps/ui must never import apps/server or apps/relay — it talks to the server over REST only.',
      severity: 'error',
      from: { path: '(^|/)apps/ui/' },
      to: { path: '(^|/)apps/(server|relay)/' },
    },
    {
      name: 'ui-no-node-packages',
      comment: 'apps/ui must not import server-side workspace packages — it has zero @second-brain/* deps.',
      severity: 'error',
      from: { path: '(^|/)apps/ui/' },
      to: { path: '(^|/)packages/(core|collectors|ingestion|mcp-server|sync)/' },
    },
    {
      name: 'core-only-types',
      comment: 'packages/core may depend only on packages/types, never on sibling workspace packages.',
      severity: 'error',
      from: { path: '(^|/)packages/core/' },
      to: { path: '(^|/)packages/(collectors|ingestion|mcp-server|sync)/' },
    },
    {
      name: 'types-is-leaf',
      comment: 'packages/types is a leaf — it imports no other workspace package (intra-types imports are fine).',
      severity: 'error',
      from: { path: '(^|/)packages/types/' },
      to: {
        path: '(^|/)(packages|apps|tools)/',
        pathNot: '(^|/)packages/types/',
      },
    },
    {
      name: 'no-app-imports-from-packages',
      comment: 'packages must not import apps — dependency direction is apps -> packages only.',
      severity: 'error',
      from: { path: '(^|/)packages/' },
      to: { path: '(^|/)apps/' },
    },
    {
      name: 'relay-only-types',
      comment: 'apps/relay depends only on packages/types, never on other workspace packages.',
      severity: 'error',
      from: { path: '(^|/)apps/relay/' },
      to: { path: '(^|/)packages/(core|collectors|ingestion|mcp-server|sync)/' },
    },
    {
      name: 'no-circular',
      comment:
        'No runtime circular dependencies. viaOnly.dependencyTypesNot:[type-only] ' +
        'flags a cycle only when every edge in it is a real (non-type-only) import; ' +
        'cycles closed by a type-only import are erased at compile time and ignored.',
      severity: 'error',
      from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ['type-only'] } },
    },
    {
      name: 'no-orphans',
      comment: 'Surface unreachable files (warn only — does not fail CI).',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|json)$', // dot files
          '\\.d\\.ts$',
          '(^|/)tsconfig\\.json$',
          '(^|/)(eslint|vite|vitest|tsdown)\\.config\\.(js|cjs|mjs|ts)$',
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: ['node_modules'] },
    // Resolve cross-package `@second-brain/*` imports to TypeScript SOURCE via
    // the path mappings in tsconfig.depcruise.json (consumed by
    // tsconfig-paths-webpack-plugin). The runtime package `exports` point at
    // built `dist/*.mjs`, which is excluded from the graph below — without the
    // source mappings every workspace-to-workspace edge would vanish into dist
    // and the layering rules could never fire on cross-package imports.
    tsConfig: { fileName: 'tsconfig.depcruise.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'],
    },
    tsPreCompilationDeps: true,
    exclude: {
      path: [
        'node_modules',
        'dist',
        '\\.test\\.ts$',
        '\\.spec\\.ts$',
        '__tests__',
      ],
    },
  },
};
