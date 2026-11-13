// One way to turn a path into a comparable key. On Windows the same folder can
// be spelled with 8.3 short names (RUNNER~1) or the long ones git reports, so an
// existing path is expanded with realpathSync.native first; a path that does not
// exist keeps the plain resolve. Then trailing slashes go, and on Windows case.
import path from 'node:path';
import { realpathSync } from 'node:fs';

export function canonicalPath(p, { platform = process.platform, realpath = realpathSync.native } = {}) {
  const resolved = path.resolve(p);
  if (platform !== 'win32') return resolved;
  try {
    return realpath(resolved);
  } catch {
    return resolved;
  }
}

export function pathKey(p, { platform = process.platform, realpath } = {}) {
  const r = canonicalPath(p, { platform, realpath }).replace(/[\/]+$/, '');
  return platform === 'win32' ? r.toLowerCase() : r;
}
