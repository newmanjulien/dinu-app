import type { internal } from '../src/convex/_generated/api';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';

type Operators = {
	'operator:readSeed': typeof internal.operator.readSeed;
	'operator:bootstrap': typeof internal.operator.bootstrap;
	'authoringMigration:begin': typeof internal.authoringMigration.begin;
	'authoringMigration:step': typeof internal.authoringMigration.step;
	'authoringMigration:finish': typeof internal.authoringMigration.finish;
	'templateSourceFormatting:inspectSource': typeof internal.templateSourceFormatting.inspectSource;
	'templateSourceParser:analyzeExisting': typeof internal.templateSourceParser.analyzeExisting;
	'templateSourceFormatting:repairSource': typeof internal.templateSourceFormatting.repairSource;
	'templateSourceFormatting:normalizeSources': typeof internal.templateSourceFormatting.normalizeSources;
	'templateSourceFormatting:normalizeDetachedChunks': typeof internal.templateSourceFormatting.normalizeDetachedChunks;
	'templateSourceFormatting:recountVersions': typeof internal.templateSourceFormatting.recountVersions;
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
