#!/usr/bin/env node
// Prints the CHANGELOG.md section for one version (used by .github/workflows/release.yml):
//   node scripts/changelog-section.js 0.12.0
// The section starts at "## [0.12.0]" and stops at the next "## [" heading or at the
// link-reference footer. Exits 1 when the version is missing or its section is empty.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export function changelogSection(text, version) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const head = `## [${version}]`;
  const start = lines.findIndex((l) => l === head || l.startsWith(`${head} `));
  if (start === -1) return null;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## [') || /^\[[^\]]+\]:\s/.test(line)) break;
    body.push(line);
  }
  const out = body.join('\n').trim();
  return out || null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const version = process.argv[2];
  const section = version && changelogSection(readFileSync(`${ROOT}CHANGELOG.md`, 'utf8'), version);
  if (!section) {
    process.stderr.write(`No CHANGELOG.md section for ${version ?? '(no version given)'}\n`);
    process.exit(1);
  }
  process.stdout.write(`${section}\n`);
}
