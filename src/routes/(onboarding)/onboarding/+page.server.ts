import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/public';
import { loginHref } from '$lib/auth/navigation';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
	const auth = locals.auth?.();
	if (env.PUBLIC_CLERK_PUBLISHABLE_KEY && (!auth || !('userId' in auth) || !auth.userId))
		redirect(303, loginHref(url.pathname + url.search));
	return {};
};
