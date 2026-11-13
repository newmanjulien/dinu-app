import {
	getFunctionName,
	type FunctionArgs,
	type FunctionReference,
	type FunctionReturnType
} from 'convex/server';
import { vi } from 'vitest';
import type { SnapshotClient } from '../../src/lib/query-once';
import type { TemplateContentSnapshot } from '../../src/lib/playbook/structure';

export function deferred<T>() {
	let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

type Observation = {
	name: string;
	args: { id?: string };
	update: (value: unknown) => void;
	error: (error: Error) => void;
	released: boolean;
};
export function controlledClient(onSubscribe?: (observation: Observation) => void) {
	const observations: Observation[] = [];
	const mutation = vi.fn(() => new Promise<never>(() => {}));
	const subscribe: SnapshotClient['onUpdate'] = <Query extends FunctionReference<'query'>>(
		reference: Query,
		args: FunctionArgs<Query>,
		update: (value: FunctionReturnType<Query>) => void,
		error?: (error: Error) => unknown
	) => {
		const observation: Observation = {
			name: getFunctionName(reference),
			args,
			update: (value) => update(value as FunctionReturnType<Query>),
			error: (failure) => {
				error?.(failure);
			},
			released: false
		};
		observations.push(observation);
		onSubscribe?.(observation);
		return () => {
			observation.released = true;
		};
	};
	const onUpdate = vi.fn(subscribe);
	const live = (name: string) => observations.filter((o) => o.name === name && !o.released);
	const details = () => live('playbookItems:content');
	const publish = (name: string, value: unknown) => live(name).forEach((o) => o.update(value));
	const publishDetail = (id: string, value: TemplateContentSnapshot) =>
		details()
			.filter((o) => o.args.id === id)
			.forEach((o) => o.update(value));
	return {
		client: { onUpdate, mutation },
		observations,
		mutation,
		onUpdate,
		live,
		details,
		publish,
		publishDetail
	};
}
