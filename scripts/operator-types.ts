import type { internal } from '../src/convex/_generated/api';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';

type Operators = {
	'operator:readSeed': typeof internal.operator.readSeed;
	'operator:bootstrap': typeof internal.operator.bootstrap;
};
export type OperatorName = keyof Operators;
// IDs cross the CLI/HTTP boundary as strings; the registered server validators check them.
type Wire<T> = T extends { __tableName: string }
	? string
	: T extends readonly (infer Item)[]
		? Wire<Item>[]
		: T extends object
			? { [Key in keyof T]: Wire<T[Key]> }
			: T;
export type OperatorArgs<Name extends OperatorName> = Wire<FunctionArgs<Operators[Name]>>;
export type OperatorResult<Name extends OperatorName> = FunctionReturnType<Operators[Name]>;
