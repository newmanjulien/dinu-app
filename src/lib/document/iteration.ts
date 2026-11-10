/** Synchronous compatibility for cooperative pure-code operations. */
export function complete<T>(iterator: Generator<undefined, T>): T {
	let next = iterator.next();
	while (!next.done) next = iterator.next();
	return next.value;
}
