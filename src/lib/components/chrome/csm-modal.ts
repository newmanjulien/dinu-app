// Code is shared across workspace lifetimes; availability never is.
let pending: Promise<typeof import('./CsmBookingModal.svelte')> | undefined;
export function loadCsmModal() {
	return (pending ??= import('./CsmBookingModal.svelte').catch((error: unknown) => {
		pending = undefined;
		throw error;
	}));
}
