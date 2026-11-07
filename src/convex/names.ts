import { ConvexError } from 'convex/values';
export function normalizedName(value: string, max = 32) {
	const result = value.trim();
	if (!result || result.length > max)
		throw new ConvexError(`Name must be between 1 and ${max} characters.`);
	return result;
}
