/** The lock owns the real cookie-setting response, independently of a mounted consumer.
 * Unsupported browsers fail through existing recovery rather than mint competing credentials.
 */
export function coordinateDiscussionViewer<T>(request: () => Promise<T>): Promise<T> {
	if (!navigator.locks)
		return Promise.reject(
			new Error('This browser cannot securely establish discussion ownership.')
		);
	return navigator.locks.request('dinu-discussion-browser', request);
}
