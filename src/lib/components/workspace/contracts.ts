import type ContractsType from './Contracts.svelte';
import { recordStartup } from '$lib/auth/startup-perf';

let Contracts: typeof ContractsType | undefined;
export const getContracts = () => Contracts;
export const loadContracts = async () => {
	if (Contracts) return Contracts;
	recordStartup('contracts-results-module-requested');
	try {
		Contracts = (await import('./Contracts.svelte')).default;
		recordStartup('contracts-results-module-ready');
		return Contracts;
	} catch (error) {
		recordStartup('contracts-results-module-error');
		throw error;
	}
};
