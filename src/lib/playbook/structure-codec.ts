import { BinaryReader, BinaryWriter } from '../contract/binary';
import type { SourceTarget } from './model';
import type { ItemStructure } from './structure';

export const STRUCTURE_CODEC_VERSION = 1;
function writeTarget(writer: BinaryWriter, target: SourceTarget) {
	writer.uint(target.kind === 'boundary' ? 1 : 0);
	if (target.kind === 'boundary') writer.string(target.afterBlockKey);
	else {
		writer.string(target.range.start.sourceKey);
		writer.uint(target.range.start.offset);
		writer.string(target.range.end.sourceKey);
		writer.uint(target.range.end.offset);
	}
}
function readTarget(reader: BinaryReader): SourceTarget {
	const kind = reader.uint();
	if (kind === 1) return { kind: 'boundary', afterBlockKey: reader.string() };
	if (kind !== 0) throw new Error('Unsupported target encoding');
	return {
		kind: 'text',
		range: {
			start: { sourceKey: reader.string(), offset: reader.uint() },
			end: { sourceKey: reader.string(), offset: reader.uint() }
		}
	};
}
export function encodeStructure(item: ItemStructure): ArrayBuffer {
	const writer = new BinaryWriter();
	writer.uint(STRUCTURE_CODEC_VERSION);
	writer.string(item.trigger.id);
	writeTarget(writer, item.trigger.target);
	writer.uint(item.concessions.length);
	for (const concession of item.concessions) {
		writer.string(concession.id);
		writer.uint(concession.changes.length);
		for (const change of concession.changes) {
			writeTarget(writer, change.target);
			writer.uint(change.paragraphBreaks * 2 + Number(change.meaningful));
		}
	}
	return writer.finish();
}
export function decodeStructure(bytes: ArrayBuffer): ItemStructure {
	const reader = new BinaryReader(bytes);
	if (reader.uint() !== STRUCTURE_CODEC_VERSION) throw new Error('Unsupported structure encoding');
	const trigger = { id: reader.string(), target: readTarget(reader) };
	const count = reader.uint();
	if (count > 8192) throw new Error('Invalid structure count');
	const concessions = Array.from({ length: count }, () => {
		const id = reader.string(),
			changesCount = reader.uint();
		if (changesCount > 2) throw new Error('Invalid structure changes');
		const changes = Array.from({ length: changesCount }, () => {
			const target = readTarget(reader),
				flags = reader.uint();
			return { target, paragraphBreaks: Math.floor(flags / 2), meaningful: Boolean(flags % 2) };
		});
		return { id, changes };
	});
	reader.end();
	return { trigger, concessions };
}

/** Exact equality of the persisted compact geometry surface. */
export function equalItemStructure(a: ItemStructure, b: ItemStructure): boolean {
	const left = new Uint8Array(encodeStructure(a)),
		right = new Uint8Array(encodeStructure(b));
	return left.length === right.length && left.every((byte, i) => byte === right[i]);
}
