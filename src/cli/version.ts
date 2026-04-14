import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | undefined;

export function getPackageVersion(): string {
  if (cached) return cached;
  const currentFile = fileURLToPath(import.meta.url);
  const pkgPath = path.resolve(path.dirname(currentFile), '../../package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string };
  cached = pkg.version;
  return cached;
}
