import { spawn } from 'node:child_process';
import path from 'node:path';

import type { ToolDefinition } from '../core/providers/llm.js';
import {
  createPermissionRequirement,
  evaluatePermission,
  permissionDeniedResponse,
  type PermissionLevel,
  type PermissionRequirement,
} from './permissions.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_LENGTH = 16_000;
const TOOL_NAME = 'shell.tool';

interface CommandPolicy {
  risk: PermissionLevel;
  allowedPrefixes: string[][];
}

export interface ShellToolSkillConfig {
  allowedPaths?: string[];
  baseDirectory?: string;
  whitelist?: Record<string, CommandPolicy>;
}

const DEFAULT_WHITELIST: Record<string, CommandPolicy> = {
  pwd: {
    risk: 'low',
    allowedPrefixes: [[]],
  },
  date: {
    risk: 'low',
    allowedPrefixes: [[]],
  },
  uname: {
    risk: 'low',
    allowedPrefixes: [[]],
  },
  whoami: {
    risk: 'low',
    allowedPrefixes: [[]],
  },
  git: {
    risk: 'low',
    allowedPrefixes: [
      ['status'],
      ['diff'],
      ['log'],
      ['show'],
      ['branch'],
      ['rev-parse'],
    ],
  },
  npm: {
    risk: 'medium',
    allowedPrefixes: [['test'], ['run', 'build'], ['run', 'test'], ['run', 'lint']],
  },
  pnpm: {
    risk: 'medium',
    allowedPrefixes: [['test'], ['build'], ['lint']],
  },
};

export class ShellToolSkill {
  public readonly definition: ToolDefinition = {
    name: TOOL_NAME,
    description:
      'Runs a small allowlisted set of shell commands. Medium-risk commands require explicit confirmation.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Executable name from the configured whitelist.',
        },
        args: {
          type: 'array',
          items: {
            type: 'string',
          },
          description: 'Command arguments.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory, relative to the configured base directory unless absolute.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Maximum runtime in milliseconds. Defaults to 15000.',
        },
        confirm: {
          type: 'boolean',
          description: 'Required when the selected command policy is medium or high risk.',
        },
      },
      required: ['command'],
    },
  };

  private readonly baseDirectory: string;
  private readonly allowedPaths: string[];
  private readonly whitelist: Record<string, CommandPolicy>;

  public constructor(config: ShellToolSkillConfig = {}) {
    this.baseDirectory = path.resolve(config.baseDirectory ?? process.cwd());
    this.allowedPaths = (config.allowedPaths ?? [this.baseDirectory]).map((entry) =>
      path.resolve(entry),
    );
    this.whitelist = config.whitelist ?? DEFAULT_WHITELIST;
  }

  public getPermission(args: Record<string, unknown>): PermissionRequirement {
    const command = this.parseCommand(args.command);
    const policy = this.getCommandPolicy(command);

    return createPermissionRequirement(
      policy.risk,
      `Command ${command} is allowlisted at ${policy.risk} risk.`,
    );
  }

  public async execute(args: Record<string, unknown>): Promise<string> {
    const command = this.parseCommand(args.command);
    const policy = this.getCommandPolicy(command);
    const permission = this.getPermission(args);
    const permissionCheck = evaluatePermission(TOOL_NAME, permission, args);

    if (!permissionCheck.approved) {
      return permissionDeniedResponse(
        TOOL_NAME,
        permission,
        permissionCheck.message ?? 'Confirmation required.',
      );
    }

    const commandArgs = this.parseArgs(args.args);
    this.assertAllowedArgs(command, commandArgs, policy);

    const cwd = this.resolveAllowlistedDirectory(args.cwd);
    const timeoutMs = this.parseTimeout(args.timeoutMs);
    const result = await this.runCommand(command, commandArgs, cwd, timeoutMs);

    return JSON.stringify({
      status: result.exitCode === 0 ? 'ok' : 'error',
      tool: TOOL_NAME,
      command,
      args: commandArgs,
      cwd,
      risk: policy.risk,
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: this.trimOutput(result.stdout),
      stderr: this.trimOutput(result.stderr),
    });
  }

  private parseCommand(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error('Shell command must be a non-empty string');
    }

    return value.trim();
  }

  private getCommandPolicy(command: string): CommandPolicy {
    const policy = this.whitelist[command];

    if (policy === undefined) {
      throw new Error(`Command is not allowlisted: ${command}`);
    }

    return policy;
  }

  private parseArgs(value: unknown): string[] {
    if (value === undefined) {
      return [];
    }

    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      throw new Error('Shell args must be an array of strings');
    }

    return value;
  }

  private assertAllowedArgs(
    command: string,
    args: string[],
    policy: CommandPolicy,
  ): void {
    const matches = policy.allowedPrefixes.some((prefix) => {
      if (prefix.length > args.length) {
        return false;
      }

      return prefix.every((entry, index) => args[index] === entry);
    });

    if (!matches) {
      throw new Error(
        `Command arguments are not allowlisted for ${command}: ${args.join(' ') || '(none)'}`,
      );
    }
  }

  private resolveAllowlistedDirectory(value: unknown): string {
    if (value === undefined) {
      return this.baseDirectory;
    }

    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error('Shell cwd must be a non-empty string when provided');
    }

    const resolvedPath = path.resolve(this.baseDirectory, value.trim());

    if (!this.isAllowlisted(resolvedPath)) {
      throw new Error(`Shell cwd is outside the allowlist: ${value}`);
    }

    return resolvedPath;
  }

  private isAllowlisted(candidatePath: string): boolean {
    return this.allowedPaths.some((allowedPath) => {
      const relativePath = path.relative(allowedPath, candidatePath);

      return (
        relativePath.length === 0 ||
        (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
      );
    });
  }

  private parseTimeout(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return DEFAULT_TIMEOUT_MS;
    }

    return Math.min(Math.max(Math.trunc(value), 1), MAX_TIMEOUT_MS);
  }

  private trimOutput(value: string): string {
    if (value.length <= MAX_OUTPUT_LENGTH) {
      return value;
    }

    return `${value.slice(0, MAX_OUTPUT_LENGTH)}\n[output truncated]`;
  }

  private runCommand(
    command: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
  ): Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: process.env,
        shell: false,
      });
      let stdout = '';
      let stderr = '';
      let timeoutHandle: NodeJS.Timeout | undefined;

      child.stdout.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      child.on('error', (error: Error) => {
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
        }

        reject(error);
      });
      child.on('close', (exitCode, signal) => {
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
        }

        resolve({
          exitCode,
          signal,
          stdout,
          stderr,
        });
      });

      timeoutHandle = setTimeout(() => {
        child.kill('SIGTERM');
      }, timeoutMs);
    });
  }
}
