/** Read a signed JSON payload without buffering an unbounded request body. */
export async function readTextBody(
	reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>,
	maxBytes: number
) {
	const decoder = new TextDecoder();
	let size = 0;
	let text = '';
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > maxBytes) {
				await reader.cancel();
				return null;
			}
			text += decoder.decode(chunk.value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		reader.releaseLock();
	}
}
