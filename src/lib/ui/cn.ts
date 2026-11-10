import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Register custom tokens so local overrides merge correctly.
const mergeClasses = extendTailwindMerge({
	extend: {
		theme: {
			spacing: ['button-sm'],
			shadow: ['control', 'card', 'floating', 'dialog'],
			radius: ['base', 'modal', 'button-sm', 'button-md', 'button-lg', 'button-xl']
		},
		classGroups: { 'border-w': ['border-hairline'] }
	}
});

export function cn(...inputs: ClassValue[]) {
	return mergeClasses(clsx(inputs));
}
