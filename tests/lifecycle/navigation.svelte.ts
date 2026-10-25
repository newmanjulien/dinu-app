export const page = $state({
	url: new URL('https://test.local/contracts/contract-a'),
	route: { id: '/(workspace)/contracts/[id]' },
	data: {} as Record<string, unknown>
});
export const screen = $state({
	home: false,
	destination: { kind: 'saved', id: 'contract-a' } as
		{ kind: 'new' } | { kind: 'saved'; id: string }
});
let navigate: (path: string) => Promise<void> = async () => {};
export const setNavigate = (handler: typeof navigate) => {
	navigate = handler;
};
export const goto = (path: string) => navigate(path);
export const beforeNavigate = () => {};
export const preloadCode = async () => {};
