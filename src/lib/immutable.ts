export type DeepReadonly<T> = T extends string | number | boolean | null | undefined
	? T
	: T extends object
		? { readonly [K in keyof T]: DeepReadonly<T[K]> }
		: T;

/** Already frozen values are shared without walking their contents again. */
export function immutable<T extends object>(value: T): T {
	if (Object.isFrozen(value)) return value;
	for (const child of Object.values(value))
		if (child && typeof child === 'object') immutable(child);
	return Object.freeze(value);
}
