// Task slugs, where a task's worktrees live, and the record of each run.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { canonicalPath } from './pathkey.js';

const POLISH = { ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' };

export function slugify(text) {
  const ascii = text
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, (ch) => POLISH[ch])
    .normalize('NFKD')
    .replace(/\p{M}/gu, '');
  const full = ascii.replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').replace(/-+$/, '');
  let slug = full.slice(0, 40);
  // Cut at a word boundary when the limit falls inside a word.
  if (full.length > 40 && full[40] !== '-' && slug.lastIndexOf('-') >= 10) slug = slug.slice(0, slug.lastIndexOf('-'));
  return slug.replace(/-+$/, '') || 'task';
}

export function uniqueSlug(base, exists) {
  if (!exists(base)) return base;
  let n = 2;
  while (exists(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export function worktreeRoot({ paths, repo, task }) {
  const resolved = path.resolve(repo);
  const hash = createHash('sha1').update(canonicalPath(resolved).toLowerCase()).digest('hex').slice(0, 6);
  return path.join(paths.worktrees, `${path.basename(resolved)}-${hash}`, task);
}

const runFile = (paths, task) => path.join(paths.runs, `${task}.json`);

export function saveRun(run, { paths, writeFile, mkdir }) {
  mkdir(paths.runs, { recursive: true });
  writeFile(runFile(paths, run.task), JSON.stringify(run, null, 2));
}

export function listRuns({ paths, readdir, readFile }) {
  let names;
  try {
    names = readdir(paths.runs);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return names
    .filter((n) => n.endsWith('.json'))
    .flatMap((n) => {
      try {
        return [JSON.parse(readFile(path.join(paths.runs, n)))];
      } catch {
        return [];
      }
    });
}

export function loadRun(task, { paths, readFile }) {
  try {
    return JSON.parse(readFile(runFile(paths, task)));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}
