/** Download a server-generated file; keep the browser URL only for this click. */
export function downloadWord(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	try {
		anchor.href = url;
		anchor.download = filename;
		document.body.append(anchor);
		anchor.click();
	} finally {
		anchor.remove();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
}
