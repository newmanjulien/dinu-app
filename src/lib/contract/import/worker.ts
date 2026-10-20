import { importDocx } from './docx';
self.onmessage = (event: MessageEvent<ArrayBuffer>) => {
	try {
		self.postMessage({ result: importDocx(new Uint8Array(event.data)) });
	} catch (error) {
		self.postMessage({
			error: error instanceof Error ? error.message : 'Unable to read this Word file.'
		});
	}
};
