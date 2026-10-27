import { build } from 'esbuild';
import { build as viteBuild } from 'vite';

await build({
  entryPoints: {
    ...Object.fromEntries(
      ['gateway', 'identity', 'documents', 'signing', 'audit'].map((name) => [
        `services/${name}/index`,
        `services/${name}/src/index.ts`,
      ]),
    ),
    'services/documents/pdf-worker': 'services/documents/src/pdf-worker.ts',
  },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
});
await viteBuild({ configFile: 'apps/web/vite.config.ts' });
