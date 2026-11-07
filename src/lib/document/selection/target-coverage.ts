import { type SourceIndex } from '$lib/contract/source-index';

export function boundaryEndpoints(index: SourceIndex, key: string) {
	const boundary = index.structuralBoundaries.get(key);
	const before = index.containers.get(key)?.units.at(-1);
	const after = boundary?.nextBlockKey
		? index.containers.get(boundary.nextBlockKey)?.units[0]
		: undefined;
	return {
		before: before ? { sourceKey: before.sourceKey, offset: before.length } : undefined,
		after: after ? { sourceKey: after.sourceKey, offset: 0 } : undefined
	};
}
