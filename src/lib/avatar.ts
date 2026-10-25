import { assets, base } from '$app/paths';

export const DEFAULT_USER_AVATAR_URL = '/default-user-avatar.png';

export function resolveAvatarUrl(value: string | null | undefined): string | null {
	const url = value?.trim() || null;
	return url?.startsWith('/') ? `${assets || base}${url}` : url;
}
