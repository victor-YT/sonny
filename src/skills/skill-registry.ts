import type { ToolDefinition } from '../core/providers/llm.js';
import type { ToolRouter } from '../core/tool-router.js';
import { FileToolSkill, type FileToolSkillConfig } from './file-tool.js';
import { SandboxSkill } from './sandbox.js';
import { ShellToolSkill, type ShellToolSkillConfig } from './shell-tool.js';
import { WebSearchSkill } from './web-search.js';

export interface BuiltInSkill {
  readonly definition: ToolDefinition;
  execute(args: Record<string, unknown>): Promise<string>;
}

export interface SkillRegistryConfig {
  allowedPaths?: string[];
  baseDirectory?: string;
  fileTool?: Omit<FileToolSkillConfig, 'allowedPaths' | 'baseDirectory'>;
  shellTool?: Omit<ShellToolSkillConfig, 'allowedPaths' | 'baseDirectory'>;
  skills?: BuiltInSkill[];
}

export interface SkillSummary {
  name: string;
  description: string;
}

export class SkillRegistry {
  private readonly skills: Map<string, BuiltInSkill>;

  public constructor(config: SkillRegistryConfig = {}) {
    this.skills = new Map<string, BuiltInSkill>();

    const skills = config.skills ?? this.createDefaultSkills(config);

    for (const skill of skills) {
      this.register(skill);
    }
  }

  public register(skill: BuiltInSkill): void {
    this.skills.set(skill.definition.name, skill);
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

  public attachToRouter(toolRouter: ToolRouter): void {
    for (const skill of this.skills.values()) {
      toolRouter.register(skill.definition, (args) => skill.execute(args));
    }
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
}
