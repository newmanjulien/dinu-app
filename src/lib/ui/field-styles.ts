// Appearance is shared; height, vertical padding, and control layout stay local.
const fieldSurfaceClass = [
	'w-full rounded-button-lg border-hairline border-edge bg-surface px-3 shadow-control outline-none transition-[background-color]',
	'focus-within:border-accent focus-within:outline-solid focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-accent/18',
	'not-disabled:not-aria-disabled:[&:not([readonly])]:not-aria-invalid:hover:not-focus-within:bg-field-hover',
	'not-disabled:not-aria-disabled:aria-invalid:border-danger/30 not-disabled:not-aria-disabled:aria-invalid:bg-danger-surface not-disabled:not-aria-disabled:aria-invalid:text-danger',
	'not-disabled:not-aria-disabled:aria-invalid:focus-within:border-danger not-disabled:not-aria-disabled:aria-invalid:focus-within:outline-danger/18',
	'motion-reduce:transition-none'
].join(' ');

const fieldTextClass = 'min-w-0 text-[13px] placeholder:font-[350] placeholder:text-ink-muted';

export const fieldClass = [
	fieldSurfaceClass,
	fieldTextClass,
	'text-ink disabled:bg-canvas disabled:text-ink-muted [&[readonly]]:bg-canvas [&[readonly]]:text-ink-muted'
].join(' ');

// Composite fields put the surface on the wrapper and typography on the input.
export const fieldShellClass = [
	fieldSurfaceClass,
	'min-w-0 text-ink aria-disabled:bg-canvas aria-disabled:text-ink-muted'
].join(' ');

export const fieldInputClass = `${fieldTextClass} w-full flex-1 border-0 bg-transparent p-0 text-inherit outline-none [&::-webkit-search-cancel-button]:hidden`;
