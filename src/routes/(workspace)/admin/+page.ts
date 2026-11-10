import { redirect } from '@sveltejs/kit';

/** Preserve saved links to the former template editor route. */
export function load({ url }: { url: URL }) {
	redirect(308, `/template${url.search}`);
}
