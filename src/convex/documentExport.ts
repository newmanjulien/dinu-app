import { ConvexError } from 'convex/values';
import type { Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { readContractDocument, assertContractDocumentManifest } from './contractDocuments';
import { outputReservation } from './outputProof';

/** Exactly one source materialization, owned by the original immutable reservation. */
export async function reservedExport(
	ctx: QueryCtx,
	source: {
		companyId: Id<'company'>;
		contractId: Id<'savedContracts'>;
		outputId: Id<'contractOutputs'>;
		documentId: Id<'contractDocuments'>;
	}
) {
	const { owner, reservationManifest } = await outputReservation(ctx, source);
	if (
		!owner.outputVerification?.complete ||
		owner.outputVerification.generation !== reservationManifest.proof.generation
	)
		throw new ConvexError('This output evidence is still being checked. Try again shortly.');
	const manifest = await ctx.db.get('contractDocuments', reservationManifest.documentId);
	assertContractDocumentManifest(manifest, {
		companyId: source.companyId,
		contractId: source.contractId
	});
	if (manifest.fingerprint !== reservationManifest.documentFingerprint)
		throw new ConvexError('This output document is unavailable. Prepare a new output.');
	const document = await readContractDocument(ctx, manifest._id, {
		companyId: source.companyId,
		contractId: source.contractId
	});
	return { reservationManifest, document };
}
