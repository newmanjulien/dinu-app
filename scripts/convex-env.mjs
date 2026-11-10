import { readFile } from 'node:fs/promises';

/** @param {string} source @param {string} name */
function envValue(source, name) {
	const raw = source.match(new RegExp(String.raw`^${name}\s*=\s*(.*)$`, 'm'))?.[1]?.trim();
	if (!raw) return undefined;
	const quoted = raw.match(/^(['"])(.*?)\1/u);
	return quoted ? quoted[2] : raw.split(/\s+#/u, 1)[0].trim();
}

/** @param {string[]} names */
export async function configuredEnv(...names) {
	let source = '';
	try {
		source = await readFile('.env.local', 'utf8');
	} catch (error) {
		if ((error instanceof Error && 'code' in error ? error.code : undefined) !== 'ENOENT')
			throw error;
	}
	return Object.fromEntries(
		names.map((name) => [name, process.env[name] ?? envValue(source, name)])
	);
}
