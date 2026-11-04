import { ConvexError } from 'convex/values';

const cors = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Authorization, Content-Type',
	'Cache-Control': 'no-store'
};

export function uploadResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { ...cors, 'Content-Type': 'application/json' }
	});
}

export function uploadPreflightResponse() {
	return new Response(null, { status: 204, headers: cors });
}

export function uploadErrorMessage(error: unknown, fallback: string) {
	if (error instanceof ConvexError) {
		if (typeof error.data === 'string') return error.data;
		if (error.data && typeof error.data === 'object' && 'message' in error.data)
			return String(error.data.message);
	}
	return fallback;
}

/** Return null only when the stream exceeds the limit; reader failures propagate. */
export async function readUploadBody(
	reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>,
	maxBytes: number,
	onChunk?: (chunk: Uint8Array<ArrayBuffer>) => void
) {
	const chunks: Uint8Array<ArrayBuffer>[] = [];
	let size = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > maxBytes) {
				await reader.cancel();
				return null;
			}
			chunks.push(chunk.value);
			onChunk?.(chunk.value);
		}
	} finally {
		reader.releaseLock();
	}
	return { chunks, size };
}

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
