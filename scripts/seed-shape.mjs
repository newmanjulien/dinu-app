import { readFile } from 'node:fs/promises';
import { frozenStates } from './seed-types.ts';
// Validate JSONL with the same Convex validator descriptions used for persistence.
/** @param {unknown} value @param {import('convex/values').ValidatorJSON} schema @param {string} [path] */
export function assertShape(value, schema, path = 'record') {
	switch (schema.type) {
		case 'union':
			for (const member of schema.value) {
				try {
					assertShape(value, member, path);
					return;
				} catch {
					/* try the next variant */
				}
			}
			throw new Error(`${path} does not match any persisted variant`);
		case 'object': {
			if (!value || typeof value !== 'object' || Array.isArray(value))
				throw new Error(`${path} must be an object`);
			for (const key of Object.keys(value))
				if (!Object.hasOwn(schema.value, key))
					throw new Error(`${path}.${key} is not a persisted field`);
			for (const [key, field] of Object.entries(schema.value)) {
				if (!Object.hasOwn(value, key) && field.optional) continue;
				assertShape(
					/** @type {Record<string, unknown>} */ (value)[key],
					field.fieldType,
					`${path}.${key}`
				);
			}
			return;
		}
		case 'record':
			if (!value || typeof value !== 'object' || Array.isArray(value))
				throw new Error(`${path} must be an object`);
			for (const [key, entry] of Object.entries(value)) {
				assertShape(key, schema.keys, `${path} key`);
				assertShape(entry, schema.values.fieldType, `${path}.${key}`);
			}
			return;
		case 'array':
			if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
			value.forEach((item, i) => assertShape(item, schema.value, `${path}[${i}]`));
			return;
		case 'literal':
			if (value !== schema.value) throw new Error(`${path} must equal ${schema.value}`);
			return;
		case 'string':
		case 'boolean':
		case 'number':
			if (typeof value !== schema.type || (schema.type === 'number' && !Number.isFinite(value)))
				throw new Error(`${path} must be ${schema.type}`);
			return;
		default:
			throw new Error(`Unsupported seed validator ${schema.type}`);
	}
}

// Convex exposes this runtime descriptor but omits it from its public validator interface.
/** @param {import('convex/values').GenericValidator} validator @returns {import('convex/values').ValidatorJSON} */
export function validatorJson(validator) {
	return /** @type {import('convex/values').GenericValidator & {json:import('convex/values').ValidatorJSON}} */ (
		validator
	).json;
}

/** @returns {Promise<import('./seed-types').FrozenState[]>} */
export async function readFrozenStates() {
	const value = /** @type {unknown} */ (
		JSON.parse(await readFile('data/reference/compositor.json', 'utf8'))
	);
	assertShape(value, validatorJson(frozenStates), 'reference');
	return /** @type {import('./seed-types').FrozenState[]} */ (value);
}
