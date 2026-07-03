import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnvFile } from '../src/env';

let cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
  delete process.env.PIPBOP_TEST_A;
  delete process.env.PIPBOP_TEST_B;
  delete process.env.PIPBOP_TEST_QUOTED;
  delete process.env.PIPBOP_TEST_EXISTING;
});

function tmpEnv(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipbop-env-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, contents, 'utf8');
  return file;
}

describe('loadEnvFile', () => {
  it('returns false for a missing file', () => {
    expect(loadEnvFile(path.join(os.tmpdir(), 'nope-does-not-exist.env'))).toBe(false);
  });

  it('loads keys, ignoring comments/blanks and stripping quotes/export', () => {
    const file = tmpEnv(
      [
        '# a comment',
        '',
        'PIPBOP_TEST_A=hello',
        'export PIPBOP_TEST_B="quoted value"',
        "PIPBOP_TEST_QUOTED='single quotes'",
        'PIPBOP_TEST_INLINE=value # trailing comment',
      ].join('\n'),
    );
    expect(loadEnvFile(file)).toBe(true);
    expect(process.env.PIPBOP_TEST_A).toBe('hello');
    expect(process.env.PIPBOP_TEST_B).toBe('quoted value');
    expect(process.env.PIPBOP_TEST_QUOTED).toBe('single quotes');
    expect(process.env.PIPBOP_TEST_INLINE).toBe('value');
    delete process.env.PIPBOP_TEST_INLINE;
  });

  it('never overrides an already-set environment variable', () => {
    process.env.PIPBOP_TEST_EXISTING = 'from-real-env';
    const file = tmpEnv('PIPBOP_TEST_EXISTING=from-file');
    loadEnvFile(file);
    expect(process.env.PIPBOP_TEST_EXISTING).toBe('from-real-env');
  });
});
