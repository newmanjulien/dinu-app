import type { Address } from './numbering';
import type { SourceIndex } from './source-index';

type ReferenceRangeIndex = Pick<SourceIndex, 'numberingItems' | 'blockOrdinals'>;

/** The current visible addresses and the baseline rule that authorizes a reference range. */
export interface ReferenceCatalog {
	readonly addresses: ReadonlyMap<string, Address>;
	canRange: (startTargetItemKey: string, endTargetItemKey: string) => boolean;
}

const emptyAddresses = new Map<string, Address>();

/** Address matching must not depend on the browser or server locale. */
export function normalizeReferenceAddress(value: string) {
	return value.toLowerCase();
}

/** A range can only move forward through siblings in one numbering sequence. */
export function canReferenceRange(
	index: ReferenceRangeIndex,
	startTargetItemKey: string,
	endTargetItemKey: string
) {
	const start = index.numberingItems.get(startTargetItemKey);
	const end = index.numberingItems.get(endTargetItemKey);
	if (!start?.numbering || !end?.numbering) return false;
	const startOrdinal = index.blockOrdinals.get(start.blockKey);
	const endOrdinal = index.blockOrdinals.get(end.blockKey);
	if (startOrdinal === undefined || endOrdinal === undefined) return false;
	return (
		endOrdinal > startOrdinal &&
		end.numbering.sequenceKey === start.numbering.sequenceKey &&
		end.numbering.parentItemKey === start.numbering.parentItemKey
	);
}

export function createReferenceCatalog(
	index: (ReferenceRangeIndex & Pick<SourceIndex, 'addresses'>) | undefined,
	addresses: ReadonlyMap<string, Address> = index?.addresses ?? emptyAddresses
): ReferenceCatalog {
	return {
		addresses,
		canRange: index
			? (startTargetItemKey, endTargetItemKey) =>
					canReferenceRange(index, startTargetItemKey, endTargetItemKey)
			: () => false
	};
}
