import { access, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ToolDefinition } from '../core/providers/llm.js';
import type { PermissionLevel } from './permissions.js';

const DEFAULT_SKILLS_DIRECTORY = path.join(homedir(), '.sonny', 'skills');
const SKILL_MANIFEST_FILE = 'SKILL.md';
const SKILL_ENTRY_FILE = 'index.js';

export const COMMUNITY_SKILL_PERMISSIONS = [
  'filesystem.read',
  'filesystem.write',
  'memory.read',
  'memory.write',
  'network',
  'notifications',
  'process.env',
  'shell',
  'voice.input',
  'voice.output',
] as const;

export type CommunitySkillPermission = (typeof COMMUNITY_SKILL_PERMISSIONS)[number];

export interface CommunitySkillMetadata {
  name: string;
  title: string;
  description: string;
  longDescription: string;
  permissions: CommunitySkillPermission[];
  risk: PermissionLevel;
  version?: string;
  directory: string;
  manifestPath: string;
  entryPath: string;
}

export interface LoadedCommunitySkill {
  readonly definition: ToolDefinition;
  readonly metadata: CommunitySkillMetadata;
  execute(args: Record<string, unknown>): Promise<string>;
}

export interface CommunitySkillModule {
  execute(args: Record<string, unknown>, context: CommunitySkillContext): Promise<string> | string;
  parameters?: Record<string, unknown>;
}

export interface CommunitySkillContext {
  metadata: CommunitySkillMetadata;
}

export interface SkillLoaderConfig {
  skillsDirectory?: string;
}

interface ParsedManifest {
  name: string;
  title?: string;
  description?: string;
  version?: string;
  permissions: CommunitySkillPermission[];
  risk: PermissionLevel;
  longDescription: string;
}

type FrontmatterValue = string | string[];

export class SkillLoader {
  private readonly skillsDirectory: string;

  public constructor(config: SkillLoaderConfig = {}) {
    this.skillsDirectory = path.resolve(
      config.skillsDirectory ?? DEFAULT_SKILLS_DIRECTORY,
    );
  }

  public get directory(): string {
    return this.skillsDirectory;
  }

  public async loadSkills(): Promise<LoadedCommunitySkill[]> {
    if (!(await this.exists(this.skillsDirectory))) {
      return [];
    }

    const entries = await readdir(this.skillsDirectory, {
      withFileTypes: true,
    });
    const loadedSkills: LoadedCommunitySkill[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const skillDirectory = path.join(this.skillsDirectory, entry.name);
      const skill = await this.loadSkill(skillDirectory);

      loadedSkills.push(skill);
    }

    return loadedSkills;
  }

  public async loadSkill(skillDirectory: string): Promise<LoadedCommunitySkill> {
    const manifestPath = path.join(skillDirectory, SKILL_MANIFEST_FILE);
    const entryPath = path.join(skillDirectory, SKILL_ENTRY_FILE);
    const markdown = await this.readRequiredFile(
      manifestPath,
      'Community skill is missing SKILL.md',
    );

    if (!(await this.exists(entryPath))) {
      throw new Error(`Community skill at ${skillDirectory} is missing index.js`);
    }

    const manifest = this.parseManifest(markdown);
    const metadata: CommunitySkillMetadata = {
      name: manifest.name,
      title: manifest.title ?? manifest.name,
      description: manifest.description ?? manifest.longDescription,
      longDescription: manifest.longDescription,
      permissions: manifest.permissions,
      risk: manifest.risk,
      version: manifest.version,
      directory: skillDirectory,
      manifestPath,
      entryPath,
    };
    const module = await this.loadModule(entryPath);
    const skillModule = this.resolveSkillModule(module, skillDirectory);

    return {
      definition: {
        name: metadata.name,
        description: metadata.description,
        parameters: skillModule.parameters ?? {
          type: 'object',
          properties: {},
        },
      },
      metadata,
      execute: async (args) => {
        return skillModule.execute(args, { metadata });
      },
    };
  }

  private async readRequiredFile(
    filePath: string,
    errorPrefix: string,
  ): Promise<string> {
    try {
      return await readFile(filePath, 'utf8');
    } catch (error: unknown) {
      throw new Error(`${errorPrefix}: ${filePath}. ${this.toErrorMessage(error)}`);
    }
  }

  private async exists(targetPath: string): Promise<boolean> {
    try {
      await access(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  private parseManifest(markdown: string): ParsedManifest {
    const { frontmatter, body } = this.splitFrontmatter(markdown);
    const name = this.readRequiredString(frontmatter.name, 'name');
    const permissions = this.parsePermissions(frontmatter.permissions);
    const risk = this.parseRisk(frontmatter.risk);
    const longDescription = this.parseDescription(body);

    return {
      name,
      title: this.readOptionalString(frontmatter.title),
      description: this.readOptionalString(frontmatter.description),
      version: this.readOptionalString(frontmatter.version),
      permissions,
      risk,
      longDescription,
    };
  }

  private splitFrontmatter(markdown: string): {
    frontmatter: Record<string, FrontmatterValue>;
    body: string;
  } {
    const normalized = markdown.replace(/\r\n/g, '\n');

    if (!normalized.startsWith('---\n')) {
      throw new Error('Community skill SKILL.md must start with a frontmatter block');
    }

    const closingDelimiterIndex = normalized.indexOf('\n---\n', 4);

    if (closingDelimiterIndex === -1) {
      throw new Error('Community skill SKILL.md frontmatter is missing a closing --- line');
    }

    const frontmatterText = normalized.slice(4, closingDelimiterIndex);
    const body = normalized.slice(closingDelimiterIndex + 5).trim();

    return {
      frontmatter: this.parseFrontmatter(frontmatterText),
      body,
    };
  }

  private parseFrontmatter(text: string): Record<string, FrontmatterValue> {
    const values: Record<string, FrontmatterValue> = {};
    let activeListKey: string | undefined;

    for (const rawLine of text.split('\n')) {
      const line = rawLine.trimEnd();
      const trimmed = line.trim();

      if (trimmed.length === 0 || trimmed.startsWith('#')) {
        continue;
      }

      if (trimmed.startsWith('- ')) {
        if (activeListKey === undefined) {
          throw new Error('Community skill frontmatter contains a list item without a key');
        }

        const list = values[activeListKey];

        if (!Array.isArray(list)) {
          throw new Error(`Frontmatter key ${activeListKey} is not a list`);
        }

        list.push(this.stripQuotes(trimmed.slice(2).trim()));
        continue;
      }

      const separatorIndex = trimmed.indexOf(':');

      if (separatorIndex <= 0) {
        throw new Error(`Invalid frontmatter line: ${trimmed}`);
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const rawValue = trimmed.slice(separatorIndex + 1).trim();

      if (rawValue.length === 0) {
        values[key] = [];
        activeListKey = key;
        continue;
      }

      values[key] = this.stripQuotes(rawValue);
      activeListKey = undefined;
    }

    return values;
  }

  private parsePermissions(value: FrontmatterValue | undefined): CommunitySkillPermission[] {
    if (value === undefined) {
      throw new Error('Community skill frontmatter must declare permissions');
    }

    const rawValues = Array.isArray(value) ? value : [value];
    const permissions: CommunitySkillPermission[] = [];

    for (const rawValue of rawValues) {
      if (!this.isCommunitySkillPermission(rawValue)) {
        throw new Error(
          `Unsupported community skill permission: ${rawValue}. ` +
          `Expected one of ${COMMUNITY_SKILL_PERMISSIONS.join(', ')}`,
        );
      }

      if (!permissions.includes(rawValue)) {
        permissions.push(rawValue);
      }
    }

    return permissions;
  }

  private parseRisk(value: FrontmatterValue | undefined): PermissionLevel {
    const normalized = Array.isArray(value) ? value[0] : value;

    if (normalized === 'low' || normalized === 'medium' || normalized === 'high') {
      return normalized;
    }

    throw new Error('Community skill frontmatter risk must be one of: low, medium, high');
  }

  private parseDescription(body: string): string {
    const normalized = body.trim();

    if (normalized.length === 0) {
      throw new Error('Community skill SKILL.md must include a description after frontmatter');
    }

    const firstParagraph = normalized.split(/\n\s*\n/u)[0]?.trim() ?? '';

    return firstParagraph.length > 0 ? firstParagraph : normalized;
  }

  private readRequiredString(value: FrontmatterValue | undefined, key: string): string {
    const normalized = this.readOptionalString(value);

    if (normalized === undefined) {
      throw new Error(`Community skill frontmatter must include ${key}`);
    }

    return normalized;
  }

  private readOptionalString(value: FrontmatterValue | undefined): string | undefined {
    if (Array.isArray(value)) {
      return value[0];
    }

    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }

    return undefined;
  }

  private stripQuotes(value: string): string {
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith('\'') && value.endsWith('\''))
    ) {
      return value.slice(1, -1).trim();
    }

    return value.trim();
  }

  private async loadModule(entryPath: string): Promise<unknown> {
    const dynamicImport = new Function(
      'modulePath',
      'return import(modulePath);',
    ) as (modulePath: string) => Promise<unknown>;

    try {
      return await dynamicImport(pathToFileURL(entryPath).href);
    } catch (error: unknown) {
      throw new Error(
        `Failed to import community skill module at ${entryPath}: ${this.toErrorMessage(error)}`,
      );
    }
  }

  private resolveSkillModule(
    module: unknown,
    skillDirectory: string,
  ): CommunitySkillModule {
    const container = this.resolveModuleContainer(module);
    const execute = container.execute;
    const parameters = container.parameters;

    if (typeof execute !== 'function') {
      throw new Error(
        `Community skill at ${skillDirectory} must export execute(args, context)`,
      );
    }

    if (parameters !== undefined && !this.isRecord(parameters)) {
      throw new Error(
        `Community skill at ${skillDirectory} exported invalid parameters metadata`,
      );
    }

    return {
      execute: execute as CommunitySkillModule['execute'],
      parameters: parameters as Record<string, unknown> | undefined,
    };
  }

  private resolveModuleContainer(module: unknown): Record<string, unknown> {
    if (!this.isRecord(module)) {
      throw new Error('Community skill module export must be an object');
    }

    if (this.isRecord(module.default)) {
      return module.default;
    }

    return module;
  }

  private isCommunitySkillPermission(
    value: string,
  ): value is CommunitySkillPermission {
    return (COMMUNITY_SKILL_PERMISSIONS as readonly string[]).includes(value);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return 'Unknown error';
  }
}
