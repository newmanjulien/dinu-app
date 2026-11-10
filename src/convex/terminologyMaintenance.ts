import { ConvexError } from 'convex/values';
import schema from './schema';

/** The temporary cutover schema pauses access and cleanup until all references agree. */
export const terminologyTransition = 'terminologyMigrationState' in schema.tables;
export function requireTerminologyReady() {
	if (terminologyTransition)
		throw new ConvexError('Template maintenance is in progress. Please try again shortly.');
}
