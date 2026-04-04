export const PERMISSION_LEVELS = ['low', 'medium', 'high'] as const;

export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

export interface PermissionRequirement {
  level: PermissionLevel;
  reason: string;
  requiresConfirmation: boolean;
}

export interface PermissionCheckResult {
  approved: boolean;
  message?: string;
}

export function createPermissionRequirement(
  level: PermissionLevel,
  reason: string,
): PermissionRequirement {
  return {
    level,
    reason,
    requiresConfirmation: level !== 'low',
  };
}

export function evaluatePermission(
  toolName: string,
  requirement: PermissionRequirement,
  args: Record<string, unknown>,
): PermissionCheckResult {
  if (!requirement.requiresConfirmation) {
    return { approved: true };
  }

  if (args.confirm === true) {
    return { approved: true };
  }

  return {
    approved: false,
    message: `${toolName} requires confirmation for ${requirement.level}-risk execution. Re-run with confirm=true if the user approves.`,
  };
}

export function permissionDeniedResponse(
  toolName: string,
  requirement: PermissionRequirement,
  message: string,
): string {
  return JSON.stringify({
    status: 'permission_required',
    tool: toolName,
    risk: requirement.level,
    reason: requirement.reason,
    message,
  });
}
