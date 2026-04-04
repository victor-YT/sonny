import type {
  RuntimeConfig,
  SkillPermissionConfig,
} from '../core/config.js';
import type { ToolDefinition } from '../core/providers/llm.js';
import type { ToolRouter } from '../core/tool-router.js';
import { FileToolSkill, type FileToolSkillConfig } from './file-tool.js';
import {
  createPermissionRequirement,
  evaluatePermission,
  permissionDeniedResponse,
  type PermissionLevel,
} from './permissions.js';
import { SandboxSkill } from './sandbox.js';
import { ShellToolSkill, type ShellToolSkillConfig } from './shell-tool.js';
import { SkillLoader } from './skill-loader.js';
import { WebSearchSkill } from './web-search.js';

const PERMISSION_ORDER: Record<PermissionLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export interface BuiltInSkill {
  readonly definition: ToolDefinition;
  execute(args: Record<string, unknown>): Promise<string>;
}

export interface SkillRegistryConfig {
  runtimeConfig?: RuntimeConfig;
  permissions?: Record<string, SkillPermissionConfig>;
  allowedPaths?: string[];
  baseDirectory?: string;
  fileTool?: Omit<FileToolSkillConfig, 'allowedPaths' | 'baseDirectory'>;
  shellTool?: Omit<ShellToolSkillConfig, 'allowedPaths' | 'baseDirectory'>;
  skills?: BuiltInSkill[];
  skillLoader?: SkillLoader;
  communitySkillsDirectory?: string;
  loadCommunitySkills?: boolean;
}

export interface SkillSummary {
  name: string;
  description: string;
}

export class SkillRegistry {
  private readonly skills: Map<string, BuiltInSkill>;
  private readonly permissions: Record<string, SkillPermissionConfig>;
  private readonly attachedRouters = new Set<ToolRouter>();
  private readonly ready: Promise<void>;

  public constructor(config: SkillRegistryConfig = {}) {
    this.skills = new Map<string, BuiltInSkill>();
    this.permissions =
      config.permissions ??
      config.runtimeConfig?.skills.permissions ??
      {};

    const skills = this.createInitialSkills(config);

    for (const skill of skills) {
      this.register(skill);
    }

    this.ready = this.loadCommunitySkills(config);
  }

  public register(skill: BuiltInSkill): void {
    this.skills.set(skill.definition.name, skill);

    for (const router of this.attachedRouters) {
      router.register(skill.definition, (args) => this.executeSkill(skill, args));
    }
  }

  public unregister(name: string): boolean {
    return this.skills.delete(name);
  }

  public has(name: string): boolean {
    return this.skills.has(name);
  }

  public get(name: string): BuiltInSkill | undefined {
    return this.skills.get(name);
  }

  public list(): SkillSummary[] {
    return Array.from(this.skills.values(), (skill) => ({
      name: skill.definition.name,
      description: skill.definition.description,
    }));
  }

  public getDefinitions(): ToolDefinition[] {
    return Array.from(this.skills.values(), (skill) => skill.definition);
  }

  public whenReady(): Promise<void> {
    return this.ready;
  }

  public attachToRouter(toolRouter: ToolRouter): void {
    this.attachedRouters.add(toolRouter);

    for (const skill of this.skills.values()) {
      toolRouter.register(skill.definition, (args) => this.executeSkill(skill, args));
    }
  }

  private async executeSkill(
    skill: BuiltInSkill,
    args: Record<string, unknown>,
  ): Promise<string> {
    const permissionConfig = this.permissions[skill.definition.name];

    if (permissionConfig === undefined) {
      return skill.execute(args);
    }

    if (!permissionConfig.enabled) {
      return JSON.stringify({
        status: 'permission_denied',
        tool: skill.definition.name,
        message: `${skill.definition.name} is disabled by runtime config.`,
      });
    }

    const requestedLevel = this.resolveRequestedLevel(args, permissionConfig);

    if (PERMISSION_ORDER[requestedLevel] > PERMISSION_ORDER[permissionConfig.maxLevel]) {
      return JSON.stringify({
        status: 'permission_denied',
        tool: skill.definition.name,
        message:
          `${skill.definition.name} requested ${requestedLevel} permission, ` +
          `but runtime config limits it to ${permissionConfig.maxLevel}.`,
      });
    }

    const effectiveArgs =
      args.permissionLevel === undefined
        ? { ...args, permissionLevel: requestedLevel }
        : args;
    const permission = createPermissionRequirement(
      requestedLevel,
      `${skill.definition.name} is configured at ${requestedLevel} risk in runtime config.`,
    );
    const permissionCheck = evaluatePermission(
      skill.definition.name,
      permission,
      effectiveArgs,
    );

    if (!permissionCheck.approved) {
      return permissionDeniedResponse(
        skill.definition.name,
        permission,
        permissionCheck.message ?? 'Confirmation required.',
      );
    }

    return skill.execute(effectiveArgs);
  }

  private resolveRequestedLevel(
    args: Record<string, unknown>,
    permissionConfig: SkillPermissionConfig,
  ): PermissionLevel {
    const value = args.permissionLevel;

    if (value === 'low' || value === 'medium' || value === 'high') {
      return value;
    }

    return permissionConfig.defaultLevel;
  }

  private createInitialSkills(config: SkillRegistryConfig): BuiltInSkill[] {
    return [
      ...this.createDefaultSkills(config),
      ...(config.skills ?? []),
    ];
  }

  private createDefaultSkills(config: SkillRegistryConfig): BuiltInSkill[] {
    const baseDirectory = config.baseDirectory ?? process.cwd();
    const allowedPaths = config.allowedPaths ?? [baseDirectory];

    return [
      new SandboxSkill(),
      new WebSearchSkill(),
      new FileToolSkill({
        ...config.fileTool,
        baseDirectory,
        allowedPaths,
      }),
      new ShellToolSkill({
        ...config.shellTool,
        baseDirectory,
        allowedPaths,
      }),
    ];
  }

  private async loadCommunitySkills(
    config: SkillRegistryConfig,
  ): Promise<void> {
    if (config.loadCommunitySkills === false) {
      return;
    }

    const loader = config.skillLoader ?? new SkillLoader({
      skillsDirectory: config.communitySkillsDirectory,
    });

    try {
      const skills = await loader.loadSkills();

      for (const skill of skills) {
        if (this.skills.has(skill.definition.name)) {
          console.warn(
            `Skipping community skill ${skill.definition.name} because a skill with that name is already registered.`,
          );
          continue;
        }

        this.register(skill);
      }
    } catch (error: unknown) {
      console.warn(
        `Failed to load community skills from ${loader.directory}: ${this.toErrorMessage(error)}`,
      );
    }
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return 'Unknown error';
  }
}
