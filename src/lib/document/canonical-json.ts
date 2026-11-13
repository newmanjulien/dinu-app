/** Object field order never changes document identity; array order remains meaningful. */
export function canonicalJson(value: unknown) {
	return JSON.stringify(value, (_key, value) =>
		value && typeof value === 'object' && !Array.isArray(value)
			? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
			: value
	);
}
