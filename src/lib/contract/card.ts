import type { FunctionReturnType } from 'convex/server';
import type { api } from '../../convex/_generated/api';

export type SavedContractCard = FunctionReturnType<typeof api.contracts.browse>['page'][number];
