import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import type { CommunitySkillMetadata } from './skill-loader.js';

export interface PermissionPromptConfig {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export interface PermissionPromptResult {
  confirmed: boolean;
  typedValue: string;
}

export class PermissionPrompt {
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;

  public constructor(config: PermissionPromptConfig = {}) {
    this.input = config.input ?? stdin;
    this.output = config.output ?? stdout;
  }

  public async confirmInstall(
    metadata: CommunitySkillMetadata,
  ): Promise<PermissionPromptResult> {
    this.output.write(`${this.formatDialog(metadata)}\n`);

    const rl = readline.createInterface({
      input: this.input,
      output: this.output,
    });

    try {
      const typedValue = (await rl.question(
        'Type "install" to approve this skill, or press Enter to cancel: ',
      )).trim();

      return {
        confirmed: typedValue === 'install',
        typedValue,
      };
    } finally {
      rl.close();
    }
  }

  public formatDialog(metadata: CommunitySkillMetadata): string {
    const permissions =
      metadata.permissions.length > 0
        ? metadata.permissions.map((permission) => `- ${permission}`).join('\n')
        : '- none';
    const version = metadata.version === undefined ? 'unversioned' : metadata.version;

    return [
      'Community skill installation requires explicit approval.',
      '',
      `Skill: ${metadata.title}`,
      `Tool name: ${metadata.name}`,
      `Version: ${version}`,
      `Risk: ${metadata.risk}`,
      `Directory: ${metadata.directory}`,
      '',
      'Description:',
      metadata.longDescription,
      '',
      'Declared permissions:',
      permissions,
    ].join('\n');
  }
}
