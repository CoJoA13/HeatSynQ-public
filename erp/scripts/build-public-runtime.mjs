import { build } from 'esbuild';
// esbuild is already locked through tsx. This runs before devDependency pruning; every emitted
// runtime entry uses only existing production packages and ships no TypeScript loader.
await build({
  entryPoints: {
    'public-command': 'scripts/public-command.ts',
    'public-bootstrap': 'scripts/public-bootstrap.ts',
    seed: 'prisma/seed.ts',
    'demo-seed': 'prisma/demo-seed.ts',
    'db-reset': 'scripts/db-reset.ts',
  },
  outdir: 'scripts/public-runtime', outExtension: { '.js': '.mjs' },
  bundle: true, platform: 'node', target: 'node26', format: 'esm', packages: 'external',
  banner: { js: 'import { createRequire as __publicCreateRequire } from "node:module"; const require = __publicCreateRequire(import.meta.url);' },
  sourcemap: false,
});
