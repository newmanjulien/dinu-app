export type DeepReadonly<T> = T extends string | number | boolean | null | undefined
	? T
	: T extends object
		? { readonly [K in keyof T]: DeepReadonly<T[K]> }
		: T;

/** Already frozen values are shared without walking their contents again. */
export function immutable<T extends object>(value: T): DeepReadonly<T> {
	if (Object.isFrozen(value)) return value as DeepReadonly<T>;
	for (const child of Object.values(value))
		if (child && typeof child === 'object') immutable(child);
	// The recursive walk freezes the plain domain tree represented by this view.
	return Object.freeze(value) as DeepReadonly<T>;
}
