import type { ResolvedPathname } from '$app/types';

export type ButtonHref =
	ResolvedPathname | `${ResolvedPathname}?${string}` | `${ResolvedPathname}#${string}`;
export type ButtonType = 'button' | 'submit' | 'reset';
export type ButtonVariant = 'primary' | 'secondary' | 'ghost';
