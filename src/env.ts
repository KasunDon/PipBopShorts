import fs from 'node:fs';
import path from 'node:path';

/**
 * Minimal `.env` loader (no dependency). Reads KEY=VALUE lines from the given
 * file and sets them on `process.env` — but never overrides variables that are
 * already set in the real environment. Missing file is a no-op.
 *
 * Supports: `#` comments, blank lines, optional `export ` prefix, single/double
 * quoted values, and `\n` escapes inside double quotes.
 */
export function loadEnvFile(file = path.resolve(process.cwd(), '.env')): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice(7) : trimmed;
    const eq = withoutExport.indexOf('=');
    if (eq === -1) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!key) continue;
    let value = withoutExport.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      // Strip trailing inline comment for unquoted values.
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    // Real environment wins over the file.
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}
