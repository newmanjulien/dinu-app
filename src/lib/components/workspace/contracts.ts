import type ContractsType from './Contracts.svelte';

let Contracts: typeof ContractsType | undefined;
export const getContracts = () => Contracts;
export const loadContracts = async () =>
	(Contracts ??= (await import('./Contracts.svelte')).default);
