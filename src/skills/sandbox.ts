import { createContext, Script } from 'node:vm';

import type { ToolDefinition } from '../core/providers/llm.js';
import {
  PERMISSION_LEVELS,
  createPermissionRequirement,
  evaluatePermission,
  permissionDeniedResponse,
  type PermissionLevel,
  type PermissionRequirement,
} from './permissions.js';

const DEFAULT_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 10_000;
const TOOL_NAME = 'sandbox.execute';

interface SandboxLogEntry {
  level: 'log' | 'info' | 'warn' | 'error';
  message: string;
}

interface SandboxGlobals {
  console: {
    log: (...values: unknown[]) => void;
    info: (...values: unknown[]) => void;
    warn: (...values: unknown[]) => void;
    error: (...values: unknown[]) => void;
  };
  input: unknown;
  clearTimeout?: typeof clearTimeout;
  setTimeout?: typeof setTimeout;
  clearInterval?: typeof clearInterval;
  setInterval?: typeof setInterval;
  fetch?: typeof fetch;
  Buffer?: typeof Buffer;
  AbortController?: typeof AbortController;
  AbortSignal?: typeof AbortSignal;
}

type JsonValue =
  | boolean
  | number
  | string
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export class SandboxSkill {
  public readonly definition: ToolDefinition = {
    name: TOOL_NAME,
    description:
      'Executes JavaScript inside a Node.js vm sandbox. Medium and high permission levels require explicit confirmation.',
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'JavaScript to execute. Use return to send a final value from the sandbox.',
        },
        input: {
          description: 'Optional input exposed to the sandbox as the global input value.',
        },
        permissionLevel: {
          type: 'string',
          enum: [...PERMISSION_LEVELS],
          description:
            'low exposes only input and captured console, medium adds timers, high adds fetch and Buffer.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Maximum execution time in milliseconds. Defaults to 1000.',
        },
        confirm: {
          type: 'boolean',
          description:
            'Required when running medium-risk or high-risk sandbox executions.',
        },
      },
      required: ['code'],
    },
  };

  public getPermission(args: Record<string, unknown>): PermissionRequirement {
    const level = this.parsePermissionLevel(args.permissionLevel);

    return createPermissionRequirement(
      level,
      `Sandbox access level ${level} changes the globals exposed to untrusted code.`,
    );
  }

  public async execute(args: Record<string, unknown>): Promise<string> {
    const permission = this.getPermission(args);
    const permissionCheck = evaluatePermission(TOOL_NAME, permission, args);

    if (!permissionCheck.approved) {
      return permissionDeniedResponse(
        TOOL_NAME,
        permission,
        permissionCheck.message ?? 'Confirmation required.',
      );
    }

    const code = this.parseCode(args.code);
    const permissionLevel = this.parsePermissionLevel(args.permissionLevel);
    const timeoutMs = this.parseTimeout(args.timeoutMs);
    const logs: SandboxLogEntry[] = [];
    const intervalHandles = new Set<NodeJS.Timeout>();
    const timeoutHandles = new Set<NodeJS.Timeout>();
    const startedAt = Date.now();

    const sandbox = this.createGlobals(
      permissionLevel,
      logs,
      timeoutHandles,
      intervalHandles,
      args.input,
    );
    const context = createContext(sandbox, {
      codeGeneration: {
        strings: false,
        wasm: false,
      },
      name: 'sonny-sandbox',
    });
    const wrappedCode = `'use strict';\n(async () => {\n${code}\n})()`;
    const script = new Script(wrappedCode, {
      filename: 'sonny-sandbox.vm',
    });

    try {
      const execution = script.runInContext(context, {
        timeout: timeoutMs,
      });
      const result = await this.withTimeout(Promise.resolve(execution), timeoutMs);

      return JSON.stringify({
        status: 'ok',
        tool: TOOL_NAME,
        permissionLevel,
        durationMs: Date.now() - startedAt,
        result: this.serializeValue(result),
        logs,
      });
    } catch (error: unknown) {
      return JSON.stringify({
        status: 'error',
        tool: TOOL_NAME,
        permissionLevel,
        durationMs: Date.now() - startedAt,
        error: this.toErrorMessage(error),
        logs,
      });
    } finally {
      for (const handle of timeoutHandles) {
        clearTimeout(handle);
      }

      for (const handle of intervalHandles) {
        clearInterval(handle);
      }
    }
  }

  private parsePermissionLevel(value: unknown): PermissionLevel {
    if (typeof value === 'string' && this.isPermissionLevel(value)) {
      return value;
    }

    return 'low';
  }

  private isPermissionLevel(value: string): value is PermissionLevel {
    return PERMISSION_LEVELS.includes(value as PermissionLevel);
  }

  private parseCode(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error('Sandbox code must be a non-empty string');
    }

    return value;
  }

  private parseTimeout(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return DEFAULT_TIMEOUT_MS;
    }

    return Math.min(Math.max(Math.trunc(value), 1), MAX_TIMEOUT_MS);
  }

  private createGlobals(
    permissionLevel: PermissionLevel,
    logs: SandboxLogEntry[],
    timeoutHandles: Set<NodeJS.Timeout>,
    intervalHandles: Set<NodeJS.Timeout>,
    input: unknown,
  ): SandboxGlobals {
    const console = this.createConsole(logs);
    const sandbox: SandboxGlobals = {
      console,
      input,
    };

    if (permissionLevel === 'medium' || permissionLevel === 'high') {
      sandbox.setTimeout = ((
        handler: Parameters<typeof setTimeout>[0],
        delay?: Parameters<typeof setTimeout>[1],
        ...args: unknown[]
      ) => {
        const handle = setTimeout(
          handler,
          delay,
          ...(args as Parameters<typeof setTimeout> extends [unknown, unknown?, ...infer Rest]
            ? Rest
            : never),
        );
        timeoutHandles.add(handle);
        return handle;
      }) as typeof setTimeout;
      sandbox.clearTimeout = (handle) => {
        if (handle !== undefined) {
          if (typeof handle === 'object') {
            timeoutHandles.delete(handle);
          }

          clearTimeout(handle);
        }
      };
      sandbox.setInterval = ((
        handler: Parameters<typeof setInterval>[0],
        delay?: Parameters<typeof setInterval>[1],
        ...args: unknown[]
      ) => {
        const handle = setInterval(
          handler,
          delay,
          ...(args as Parameters<typeof setInterval> extends [
            unknown,
            unknown?,
            ...infer Rest,
          ]
            ? Rest
            : never),
        );
        intervalHandles.add(handle);
        return handle;
      }) as typeof setInterval;
      sandbox.clearInterval = (handle) => {
        if (handle !== undefined) {
          if (typeof handle === 'object') {
            intervalHandles.delete(handle);
          }

          clearInterval(handle);
        }
      };
    }

    if (permissionLevel === 'high') {
      sandbox.fetch = fetch;
      sandbox.Buffer = Buffer;
      sandbox.AbortController = AbortController;
      sandbox.AbortSignal = AbortSignal;
    }

    return sandbox;
  }

  private createConsole(logs: SandboxLogEntry[]): SandboxGlobals['console'] {
    return {
      log: (...values: unknown[]) => {
        logs.push({
          level: 'log',
          message: this.formatLogMessage(values),
        });
      },
      info: (...values: unknown[]) => {
        logs.push({
          level: 'info',
          message: this.formatLogMessage(values),
        });
      },
      warn: (...values: unknown[]) => {
        logs.push({
          level: 'warn',
          message: this.formatLogMessage(values),
        });
      },
      error: (...values: unknown[]) => {
        logs.push({
          level: 'error',
          message: this.formatLogMessage(values),
        });
      },
    };
  }

  private formatLogMessage(values: unknown[]): string {
    return values
      .map((value) => {
        const serialized = this.serializeValue(value);

        return typeof serialized === 'string'
          ? serialized
          : JSON.stringify(serialized);
      })
      .join(' ');
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timeoutHandle: NodeJS.Timeout | undefined;

    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(
              new Error(`Sandbox execution exceeded timeout of ${timeoutMs}ms`),
            );
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private serializeValue(
    value: unknown,
    depth = 0,
    seen = new WeakSet<object>(),
  ): JsonValue {
    if (value === null || value === undefined) {
      return null;
    }

    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      return value;
    }

    if (typeof value === 'bigint') {
      return value.toString();
    }

    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack ?? '',
      };
    }

    if (typeof value === 'function') {
      return `[Function ${value.name || 'anonymous'}]`;
    }

    if (depth >= 4) {
      return '[MaxDepth]';
    }

    if (Array.isArray(value)) {
      return value.map((entry) => this.serializeValue(entry, depth + 1, seen));
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    if (typeof value === 'object') {
      if (seen.has(value)) {
        return '[Circular]';
      }

      seen.add(value);

      const output: { [key: string]: JsonValue } = {};

      for (const [key, entry] of Object.entries(value)) {
        output[key] = this.serializeValue(entry, depth + 1, seen);
      }

      return output;
    }

    return String(value);
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return 'Unknown sandbox error';
  }
}
