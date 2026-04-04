import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ToolDefinition } from '../core/providers/llm.js';
import {
  createPermissionRequirement,
  type PermissionRequirement,
} from './permissions.js';

const DEFAULT_ENCODING = 'utf-8';
const DEFAULT_MAX_BYTES = 1_000_000;
const TOOL_NAME = 'file.tool';

type FileAction = 'read' | 'write';

export interface FileToolSkillConfig {
  allowedPaths?: string[];
  baseDirectory?: string;
}

export class FileToolSkill {
  public readonly definition: ToolDefinition = {
    name: TOOL_NAME,
    description:
      'Reads and writes text files inside an allowlisted set of directories.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'write'],
          description: 'Whether to read or write a file.',
        },
        path: {
          type: 'string',
          description: 'File path, relative to the configured base directory unless absolute.',
        },
        content: {
          type: 'string',
          description: 'Text content to write when action is write.',
        },
        append: {
          type: 'boolean',
          description: 'Append to the file instead of replacing it.',
        },
        encoding: {
          type: 'string',
          description: 'Text encoding. Defaults to utf-8.',
        },
        maxBytes: {
          type: 'number',
          description:
            'Maximum file size to read in bytes. Defaults to 1000000 bytes.',
        },
      },
      required: ['action', 'path'],
    },
  };

  private readonly baseDirectory: string;
  private readonly allowedPaths: string[];

  public constructor(config: FileToolSkillConfig = {}) {
    this.baseDirectory = path.resolve(config.baseDirectory ?? process.cwd());
    this.allowedPaths = (config.allowedPaths ?? [this.baseDirectory]).map((entry) =>
      path.resolve(entry),
    );
  }

  public getPermission(): PermissionRequirement {
    return createPermissionRequirement(
      'low',
      'File access is restricted to allowlisted directories.',
    );
  }

  public async execute(args: Record<string, unknown>): Promise<string> {
    const action = this.parseAction(args.action);
    const targetPath = this.resolveAllowlistedPath(args.path);
    const encoding = this.parseEncoding(args.encoding);

    if (action === 'read') {
      return this.readTextFile(targetPath, encoding, args.maxBytes);
    }

    return this.writeTextFile(targetPath, encoding, args.content, args.append);
  }

  private parseAction(value: unknown): FileAction {
    if (value === 'read' || value === 'write') {
      return value;
    }

    throw new Error('File action must be either read or write');
  }

  private resolveAllowlistedPath(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error('File path must be a non-empty string');
    }

    const trimmedPath = value.trim();
    const resolvedPath = path.resolve(this.baseDirectory, trimmedPath);

    if (!this.isAllowlisted(resolvedPath)) {
      throw new Error(`Path is outside the allowlist: ${trimmedPath}`);
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

  private parseEncoding(value: unknown): BufferEncoding {
    if (typeof value !== 'string' || value.trim().length === 0) {
      return DEFAULT_ENCODING;
    }

    const normalized = value.trim().toLowerCase();

    if (!Buffer.isEncoding(normalized)) {
      throw new Error(`Unsupported file encoding: ${value}`);
    }

    return normalized;
  }

  private parseMaxBytes(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return DEFAULT_MAX_BYTES;
    }

    return Math.max(Math.trunc(value), 1);
  }

  private parseContent(value: unknown): string {
    if (typeof value !== 'string') {
      throw new Error('File content must be a string when writing');
    }

    return value;
  }

  private async readTextFile(
    targetPath: string,
    encoding: BufferEncoding,
    maxBytesInput: unknown,
  ): Promise<string> {
    const fileStats = await stat(targetPath);
    const maxBytes = this.parseMaxBytes(maxBytesInput);

    if (fileStats.size > maxBytes) {
      throw new Error(
        `Refusing to read ${targetPath} because it exceeds the ${maxBytes}-byte limit`,
      );
    }

    const content = await readFile(targetPath, { encoding });

    return JSON.stringify({
      status: 'ok',
      tool: TOOL_NAME,
      action: 'read',
      path: targetPath,
      bytes: Buffer.byteLength(content, encoding),
      content,
    });
  }

  private async writeTextFile(
    targetPath: string,
    encoding: BufferEncoding,
    contentInput: unknown,
    appendInput: unknown,
  ): Promise<string> {
    const content = this.parseContent(contentInput);
    const append = appendInput === true;

    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content, {
      encoding,
      flag: append ? 'a' : 'w',
    });

    return JSON.stringify({
      status: 'ok',
      tool: TOOL_NAME,
      action: 'write',
      path: targetPath,
      append,
      bytesWritten: Buffer.byteLength(content, encoding),
    });
  }
}
