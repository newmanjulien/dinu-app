// Local file preparation only. This script does not connect to or deploy a backend.
import { readFile, writeFile, unlink } from 'node:fs/promises';
const schema = 'src/convex/schema.ts';
const canonical = 'src/convex/readabilityCanonicalSchema.ts';
const marker = '// READABILITY TRANSITION: restore the canonical schema before normal operation.';
const command = process.argv[2];
if (process.argv.length !== 3 || !['prepare', 'restore'].includes(command ?? ''))
	throw new Error('Usage: node scripts/readability-transition.mjs prepare|restore');
if (command === 'prepare') {
	const contents = await readFile(schema, 'utf8');
	if (contents.includes(marker)) throw new Error('The transition schema is already prepared.');
	await writeFile(canonical, contents, { flag: 'wx' });
	await writeFile(
		schema,
		`${marker}\nimport { defineSchema } from 'convex/server';\nimport canonical from './readabilityCanonicalSchema';\nimport { legacyTables } from '../../scripts/readability-legacy-tables';\nexport default defineSchema({ ...canonical.tables, ...legacyTables }, { schemaValidation: false });\n`
	);
} else {
	if (!(await readFile(schema, 'utf8')).startsWith(marker))
		throw new Error('Refusing to overwrite a schema without the transition marker.');
	await writeFile(schema, await readFile(canonical, 'utf8'));
	await unlink(canonical);
}
console.log(
	`${command === 'prepare' ? 'Prepared temporary transition' : 'Restored strict canonical'} schema locally. No deployment was run.`
);
