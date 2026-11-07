/** Private storage codecs preserve arbitrary JavaScript strings, including lone surrogates. */
function loneSurrogate(value: string, index: number) {
	const code = value.charCodeAt(index);
	if (code >= 0xd800 && code <= 0xdbff) {
		const next = value.charCodeAt(index + 1);
		return !(next >= 0xdc00 && next <= 0xdfff);
	}
	if (code >= 0xdc00 && code <= 0xdfff) {
		const previous = value.charCodeAt(index - 1);
		return !(previous >= 0xd800 && previous <= 0xdbff);
	}
	return false;
}
export class BinaryWriter {
	private bytes = new Uint8Array(1024);
	private cursor = 0;
	private reserve(size: number) {
		if (this.cursor + size <= this.bytes.length) return;
		let capacity = this.bytes.length;
		while (capacity < this.cursor + size) capacity *= 2;
		const next = new Uint8Array(capacity);
		next.set(this.bytes);
		this.bytes = next;
	}
	uint(value: number) {
		if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid storage integer');
		this.reserve(8);
		do {
			const byte = value % 128;
			value = Math.floor(value / 128);
			this.bytes[this.cursor++] = byte | (value ? 128 : 0);
		} while (value);
	}
	string(value: string) {
		// Scalar runs use UTF-8; only unmatched surrogates use raw UTF-16. Counting runs
		// twice avoids allocating one object per segment for adversarial mixed keys.
		let count = 1,
			raw = loneSurrogate(value, 0);
		for (let i = 1; i < value.length; i++) {
			const next = loneSurrogate(value, i);
			if (next !== raw) {
				count++;
				raw = next;
			}
		}
		this.uint(value.length);
		this.uint(count);
		let start = 0;
		raw = loneSurrogate(value, 0);
		for (let i = 1; i <= value.length || (!value.length && i === 1); i++) {
			const end = !value.length || i === value.length,
				next = !end && loneSurrogate(value, i);
			if (!end && next === raw) continue;
			const limit = Math.min(i, value.length);
			if (raw) {
				this.uint((limit - start) * 4 + 1);
				this.reserve((limit - start) * 2);
				for (let j = start; j < limit; j++) {
					const code = value.charCodeAt(j);
					this.bytes[this.cursor++] = code & 255;
					this.bytes[this.cursor++] = code >>> 8;
				}
			} else {
				const encoded = new TextEncoder().encode(value.slice(start, limit));
				this.uint(encoded.length * 2);
				this.reserve(encoded.length);
				this.bytes.set(encoded, this.cursor);
				this.cursor += encoded.length;
			}
			if (end) break;
			start = i;
			raw = next;
		}
	}
	finish(): ArrayBuffer {
		return this.bytes.slice(0, this.cursor).buffer;
	}
}
export class BinaryReader {
	private cursor = 0;
	private bytes: Uint8Array;
	constructor(value: ArrayBuffer) {
		this.bytes = new Uint8Array(value);
	}
	uint() {
		let value = 0,
			scale = 1;
		for (let i = 0; i < 8; i++) {
			if (this.cursor >= this.bytes.length) throw new Error('Incomplete storage integer');
			const byte = this.bytes[this.cursor++];
			value += (byte & 127) * scale;
			if (!Number.isSafeInteger(value)) throw new Error('Invalid storage integer');
			if (!(byte & 128)) return value;
			scale *= 128;
		}
		throw new Error('Invalid storage integer');
	}
	string() {
		const length = this.uint(),
			count = this.uint();
		if (
			!count ||
			count > this.bytes.length - this.cursor ||
			length > this.bytes.length - this.cursor
		)
			throw new Error('Invalid storage string frames');
		const units = new Uint16Array(length);
		let cursor = 0;
		for (let frameIndex = 0; frameIndex < count; frameIndex++) {
			const frame = this.uint(),
				size = Math.floor(frame / 2);
			if (this.cursor + size > this.bytes.length) throw new Error('Incomplete storage string');
			const bytes = this.bytes.subarray(this.cursor, (this.cursor += size));
			if (!(frame & 1)) {
				const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
				if (cursor + text.length > length) throw new Error('Invalid storage string length');
				for (let i = 0; i < text.length; i++) units[cursor++] = text.charCodeAt(i);
			} else {
				if (size % 2 || cursor + size / 2 > length)
					throw new Error('Invalid UTF-16 storage string');
				for (let i = 0; i < size; i += 2) units[cursor++] = bytes[i] | (bytes[i + 1] << 8);
			}
		}
		if (cursor !== length) throw new Error('Invalid storage string length');
		const parts: string[] = [];
		for (let offset = 0; offset < units.length; offset += 8192)
			parts.push(String.fromCharCode(...units.subarray(offset, offset + 8192)));
		return parts.join('');
	}
	end() {
		if (this.cursor !== this.bytes.length) throw new Error('Trailing storage data');
	}
}
