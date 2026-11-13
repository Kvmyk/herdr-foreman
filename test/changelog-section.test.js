import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { changelogSection } from '../scripts/changelog-section.js';

const text = [
  '# Changelog', '', '## [Unreleased]', '', '## [1.1.0] - 2026-01-02', '', '### Added', '', '- b', '',
  '## [1.0.0] - 2026-01-01', '', '- a', '', '[Unreleased]: https://x/compare/v1.1.0...HEAD', '[1.0.0]: https://x/v1.0.0',
].join('\n');

test('returns the section up to the next heading', () => {
  assert.equal(changelogSection(text, '1.1.0'), '### Added\n\n- b');
});

test('stops at the link-reference footer', () => {
  assert.equal(changelogSection(text, '1.0.0'), '- a');
});

test('missing or empty sections give null', () => {
  assert.equal(changelogSection(text, '9.9.9'), null);
  assert.equal(changelogSection(text, 'Unreleased'), null);
});

test('handles CRLF and the real changelog', () => {
  assert.equal(changelogSection(text.replace(/\n/g, '\r\n'), '1.0.0'), '- a');
  const real = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  assert.ok(changelogSection(real, '0.12.0'));
});
