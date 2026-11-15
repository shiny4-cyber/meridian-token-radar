import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const input = process.env.SNAPSHOT_PATH || '/root/work/makefun/token-radar/token-radar-01-kit/input/snapshot.json';
test('build rejects normalized repository-root and nested output paths before writing', () => {
  const scratch = '/root/.hermes/cache/scratch';
  mkdirSync(scratch, { recursive: true });
  const temporary = mkdtempSync(join(scratch, 'meridian-path-test-'));
  try {
    for (const file of ['main.ts', 'package.json', 'dashboard', 'vendor']) cpSync(join(repo, file), join(temporary, file), { recursive: true });
    for (const output of [temporary, join(temporary, 'nested-output')]) {
      const result = spawnSync(process.execPath, [join(temporary, 'main.ts'), '--input', input, '--preview'], {
        env: { ...process.env, MAKEFUN_OUTPUT_DIR: output }, encoding: 'utf8'
      });
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /Keep generated output outside the source repository/);
      assert.equal(existsSync(join(output, 'board.json')), false);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
