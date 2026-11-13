import { activityBrowser, scopeFor } from '$lib/server/activity-browser';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ cookies, params }) => {
	if (cookies.get('dinu_activity_choices_v1'))
		cookies.delete('dinu_activity_choices_v1', { path: '/' });
	return {
		hasAccountSession: !!cookies.get('__session'),
		buyerPreferenceScope: params.token ? scopeFor(params.token) : null,
		activityBrowser: params.token ? activityBrowser(cookies, params.token) : null
	};
};
