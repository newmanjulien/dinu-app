import { permissionsForRole, type Permissions, type Role } from '../../convex/permissions';
import type { RouteDescription } from './routes';

export type WorkspaceAdmissionState = {
	permissions?: Permissions;
	role?: Role;
	templateReady?: boolean;
	instructionsReady?: boolean;
};

export type WorkspaceAdmission =
	{ kind: 'allow' } | { kind: 'redirect'; to: string; label: string; errorMessage: string };

export function permissionsForState(state: Pick<WorkspaceAdmissionState, 'permissions' | 'role'>) {
	return state.permissions ?? (state.role ? permissionsForRole(state.role) : undefined);
}

/** Single route-admission policy shared by Workspace and WorkspaceSkeleton. */
export function resolveWorkspaceRoute(
	route: RouteDescription,
	state: WorkspaceAdmissionState
): WorkspaceAdmission {
	const permissions = permissionsForState(state);
	if (route.permission && permissions && !permissions[route.permission]) {
		return {
			kind: 'redirect',
			to: '/contracts',
			label: 'Opening your workspace',
			errorMessage: 'We couldn’t open your workspace. Please try again.'
		};
	}
	if (route.template === 'pending-only' && state.templateReady === true) {
		const to = permissions?.manageTemplate ? '/template' : '/contracts';
		return {
			kind: 'redirect',
			to,
			label: 'Opening your workspace',
			errorMessage: 'We couldn’t open your workspace. Please try again.'
		};
	}
	if (route.template === 'required' && state.templateReady === false) {
		const to = permissions?.manageTemplate ? '/template/setup' : '/contracts';
		return {
			kind: 'redirect',
			to,
			label: to === '/template/setup' ? 'Opening template setup' : 'Opening your workspace',
			errorMessage:
				to === '/template/setup'
					? 'We couldn’t open template setup. Please try again.'
					: 'We couldn’t open your workspace. Please try again.'
		};
	}
	if (route.requiresInstructions && state.instructionsReady === false) {
		const to = permissions?.manageTemplate ? '/template' : '/contracts';
		return {
			kind: 'redirect',
			to,
			label: to === '/template' ? 'Opening your template' : 'Opening your workspace',
			errorMessage:
				to === '/template'
					? 'We couldn’t open your template. Please try again.'
					: 'We couldn’t open your workspace. Please try again.'
		};
	}
	return { kind: 'allow' };
}
