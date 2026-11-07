export type CsmBookingMode = 'setup' | 'support';
import type { Id } from '../../../convex/_generated/dataModel';
export type CsmReplacement = { appointmentId: Id<'csmSetupAppointments'>; currentUid: string };
