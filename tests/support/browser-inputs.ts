// External SvelteKit inputs for the Node cache tests; application code stays real.
export const browser = true;
export const dev = false;
export const env = { PUBLIC_CONVEX_URL: 'https://performance.test' };
export async function preloadCode() {}
