import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ShellToolSkill } from '../src/skills/shell-tool.js';

test('ShellToolSkill omits raw stderr from tool results', async () => {
  const tool = new ShellToolSkill();
  const result = await tool.execute({
    command: 'git',
    args: ['status', '--definitely-not-a-real-flag'],
  });
  const parsed = JSON.parse(result) as Record<string, unknown>;

  assert.equal(parsed.status, 'error');
  assert.equal('stderr' in parsed, false);
  assert.equal(parsed.stderrOmitted, true);
  assert.equal(typeof parsed.stderrLength, 'number');
});
