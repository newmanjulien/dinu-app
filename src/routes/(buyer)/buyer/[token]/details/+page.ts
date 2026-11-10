import { redirect } from '@sveltejs/kit';
import { buyerPath } from '$lib/buyer/urls';

export const load = ({ params }) => redirect(307, buyerPath(params.token));
