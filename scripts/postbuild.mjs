/**
 * The package is `"type": "module"`, so the CommonJS build needs its own
 * `package.json` saying otherwise — otherwise Node reads `dist/cjs/*.js` as ESM and
 * every `require('terms-acceptance')` fails with ERR_REQUIRE_ESM.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

for (const [dir, type] of [
	['cjs', 'commonjs'],
	['esm', 'module'],
]) {
	const target = join(root, 'dist', dir);
	await mkdir(target, { recursive: true });
	await writeFile(join(target, 'package.json'), `${JSON.stringify({ type }, null, '\t')}\n`, 'utf8');
}

console.log('postbuild: wrote dist/cjs/package.json and dist/esm/package.json');
