// Local preparation only. No deployment or database operation is performed.
import { readFile, writeFile, unlink } from 'node:fs/promises';
const schema = 'src/convex/schema.ts';
const canonical = 'src/convex/terminologyCanonicalSchema.ts';
const marker = '// TERMINOLOGY TRANSITION: app access and cleanup are paused.';
const command = process.argv[2];
if (process.argv.length !== 3 || !['prepare', 'restore'].includes(command ?? ''))
	throw new Error('Usage: node scripts/terminology-transition.mjs prepare|restore');
if (command === 'prepare') {
	const contents = await readFile(schema, 'utf8');
	if (contents.includes('TRANSITION:')) throw new Error('Another transition is already prepared.');
	await writeFile(canonical, contents, { flag: 'wx' });
	await writeFile(
		schema,
		`${marker}
import { defineSchema } from 'convex/server';
import canonical from './terminologyCanonicalSchema';
import { terminologyTables } from '../../scripts/terminology-legacy-tables';
export default defineSchema({ ...canonical.tables, ...terminologyTables }, { schemaValidation: false });
`
	);
} else {
	if (!(await readFile(schema, 'utf8')).startsWith(marker))
		throw new Error('Refusing to overwrite a schema without the terminology transition marker.');
	await writeFile(schema, await readFile(canonical, 'utf8'));
	await unlink(canonical);
}
console.log(
	`${command === 'prepare' ? 'Prepared temporary transition' : 'Restored strict canonical'} schema locally. No deployment was run.`
);
