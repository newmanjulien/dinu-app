import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';

export async function readCompanySetup(ctx: QueryCtx, company: Doc<'company'>) {
	const row = await ctx.db
		.query('companySetupState')
		.withIndex('by_companyId', (q) => q.eq('companyId', company._id))
		.unique();
	return {
		row,
		setupAppointmentId: row?.setupAppointmentId,
		setupIntake: row?.setupIntake
	};
}

type CompanySetup = Awaited<ReturnType<typeof readCompanySetup>>;

export async function setSetupAppointment(
	ctx: MutationCtx,
	company: Doc<'company'>,
	state: CompanySetup,
	setupAppointmentId: Id<'csmSetupAppointments'> | undefined
) {
	if (state.row) {
		await ctx.db.patch('companySetupState', state.row._id, { setupAppointmentId });
	} else {
		await ctx.db.insert('companySetupState', {
			companyId: company._id,
			...(setupAppointmentId ? { setupAppointmentId } : {}),
			...(state.setupIntake ? { setupIntake: state.setupIntake } : {})
		});
	}
}

export async function setSetupIntake(
	ctx: MutationCtx,
	company: Doc<'company'>,
	state: CompanySetup,
	setupIntake: NonNullable<Doc<'companySetupState'>['setupIntake']>
) {
	if (state.row) {
		await ctx.db.patch('companySetupState', state.row._id, { setupIntake });
	} else {
		await ctx.db.insert('companySetupState', {
			companyId: company._id,
			...(state.setupAppointmentId ? { setupAppointmentId: state.setupAppointmentId } : {}),
			setupIntake
		});
	}
}

export async function deleteCompanySetup(ctx: MutationCtx, companyId: Id<'company'>) {
	const row = await ctx.db
		.query('companySetupState')
		.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
		.unique();
	if (row) await ctx.db.delete('companySetupState', row._id);
}

export async function patchCompanySetup(
	ctx: MutationCtx,
	companyId: Id<'company'>,
	patch: Partial<Omit<Doc<'companySetupState'>, '_id' | '_creationTime' | 'companyId'>>
) {
	const row = await ctx.db
		.query('companySetupState')
		.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
		.unique();
	if (row) await ctx.db.patch('companySetupState', row._id, patch);
	else await ctx.db.insert('companySetupState', { companyId, ...patch });
}
