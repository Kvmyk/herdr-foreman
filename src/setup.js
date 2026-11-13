// Setting foreman up so nobody has to: add foreman to herdr, bind the
// shortcut in herdr's config.toml, pick a lead agent that is installed, and
// say in plain words what works and what to do next.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createUi } from './ui.js';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, paths } from './config.js';
import { HERDR_KINDS } from './inventory/kinds.js';
import { findTool } from './backend.js';

export const PLUGIN_ID = 'herdr-foreman';
export const ACTION = `${PLUGIN_ID}.start`;
// None of these is a herdr default; the first one the user's config leaves free wins.
export const KEY_CHOICES = Object.freeze(['prefix+f', 'prefix+shift+f', 'prefix+alt+f']);
export const MIN_HERDR = '0.9.5';
export const MIN_NODE = 20;
// The Herdr desktop app: a mod opened by one key; the first of these keys.json leaves free wins.
export const APP_MOD = 'foreman';
export const APP_ACTION = `mod.open:${APP_MOD}`;
export const APP_KEY_CHOICES = Object.freeze(['ctrl-shift-y', 'ctrl-alt-shift-f', 'ctrl-shift-f10']);
const APP_MARKER = /^\/\/ foreman-managed (\S+) ([0-9a-f]{64})\r?\n/;
export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
// Agents known to follow the leader's instructions well, best first.
const LEADER_ORDER = ['claude', 'codex', 'opencode', 'gemini', 'agy', 'pi'];

// What config.toml already binds. A small line scanner, enough for the
// [keys] table and [[keys.command]] blocks; herdr itself validates the result.
export function parseKeys(text) {
  let table = '';
  let block = null;
  const blocks = [];
  const used = [];
  let prefix = 'ctrl+b';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const header = line.match(/^(\[\[?)\s*([^\]]+?)\s*\]\]?/);
    if (header) {
      table = header[2];
      block = header[1] === '[[' && table === 'keys.command' ? {} : null;
      if (block) blocks.push(block);
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/);
    if (!kv) continue;
    const value = kv[2] ?? kv[3];
    if (block) block[kv[1]] = value;
    else if (table === 'keys' && kv[1] === 'prefix') prefix = value;
    else if (table === 'keys') used.push(value);
  }
  for (const b of blocks) if (b.key) used.push(b.key);
  const ours = blocks.find((b) => b.type === 'plugin_action' && b.command === ACTION)?.key ?? null;
  return { prefix, used, ours };
}

export function bindingBlock(key) {
  return [
    '# Added by foreman: press this in herdr to start a new task.',
    '[[keys.command]]',
    `key = "${key}"`,
    'type = "plugin_action"',
    `command = "${ACTION}"`,
    'description = "foreman: new task"',
    '',
  ].join('\n');
}

export function addBinding(text, key) {
  if (!text.trim()) return bindingBlock(key);
  return `${text.replace(/\s*$/, '')}\n\n${bindingBlock(key)}`;
}

const cap = (part) => (part.length === 1 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1));
const chord = (k) => k.split('+').map(cap).join('+');

// "prefix+shift+f" with prefix "ctrl+b" -> "Ctrl+B, then Shift+F"
export function humanKey(key, prefix = 'ctrl+b') {
  if (!key.startsWith('prefix+')) return chord(key);
  return `${chord(prefix)}, then ${chord(key.slice('prefix+'.length))}`;
}

export function versionAtLeast(version, min) {
  const a = String(version).match(/\d+(\.\d+)*/)?.[0].split('.').map(Number) ?? [];
  const b = min.split('.').map(Number);
  for (let i = 0; i < b.length; i++) {
    if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) > b[i];
  }
  return true;
}

// Order of two package versions such as 0.6.0 and 0.7.0-dev: -1, 0 or 1. A
// pre-release sorts before its release.
export function compareVersions(a, b) {
  const [coreA, preA = ''] = String(a).split('-', 2);
  const [coreB, preB = ''] = String(b).split('-', 2);
  const x = coreA.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const y = coreB.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? 1 : -1;
  }
  if (preA === preB) return 0;
  if (!preA || !preB) return preA ? -1 : 1;
  return preA > preB ? 1 : -1;
}

// Where herdr reads config.toml: the env override, else what herdr --help
// reports, else herdr's documented default.
export async function configPath({ run, env, platform = process.platform, homedir }) {
  if (env.HERDR_CONFIG_PATH) return env.HERDR_CONFIG_PATH;
  try {
    const res = await run('herdr', ['--help'], { env, timeoutMs: 10000 });
    const m = `${res.stdout}`.match(/^Config:\s*(.+?)\s*$/m);
    if (m) return m[1];
  } catch {
    // herdr missing: fall through to the default
  }
  if (platform === 'win32') return path.win32.join(env.APPDATA ?? path.win32.join(homedir, 'AppData', 'Roaming'), 'herdr', 'config.toml');
  return path.posix.join(homedir, '.config', 'herdr', 'config.toml');
}

// The problems `herdr config check` reports for a file; it exits 1 when there are any.
export async function configIssues({ run, env, file }) {
  const res = await run('herdr', ['config', 'check'], { env: { ...env, HERDR_CONFIG_PATH: file }, timeoutMs: 15000 });
  const text = `${res.stdout}\n${res.stderr}`;
  if (/config:\s*ok/.test(text)) return [];
  const at = text.indexOf('config: issues found');
  if (at < 0) throw new Error(`herdr config check gave no answer (${text.trim().split(/\r?\n/)[0] || `exit ${res.code}`})`);
  return text.slice(at + 'config: issues found'.length).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

const notInstalled = (err) => (err.code === 'ENOENT' ? 'herdr is not installed' : err.message);

// Bind the foreman shortcut unless some key already runs it. Every change
// is checked by herdr on a temporary copy first: herdr ignores a config file
// it cannot read, which would silently drop all of the user's settings.
export async function bindKey(d) {
  const file = await configPath(d);
  let text = '';
  let existed = true;
  try {
    text = d.readFile(file);
  } catch (err) {
    if (err.code !== 'ENOENT') return { status: 'failed', file, reason: `cannot read ${file}: ${err.message}` };
    existed = false;
  }
  const keys = parseKeys(text);
  if (keys.ours) return { status: 'already', file, key: keys.ours, prefix: keys.prefix };

  let baseline = [];
  try {
    if (existed) baseline = await configIssues({ ...d, file });
  } catch (err) {
    return { status: 'failed', file, reason: notInstalled(err) };
  }
  if (baseline.some((i) => /parse error/.test(i))) {
    return { status: 'failed', file, reason: `herdr cannot read its settings file ${file}; type "herdr config check" to see the mistake` };
  }

  const candidateFile = path.join(d.tmpdir, `foreman-herdr-config-${process.pid}.toml`);
  try {
    for (const key of KEY_CHOICES.filter((k) => !keys.used.includes(k))) {
      const candidate = addBinding(text, key);
      d.writeFile(candidateFile, candidate);
      const fresh = (await configIssues({ ...d, file: candidateFile })).filter((i) => !baseline.includes(i));
      if (fresh.some((i) => i.includes(key))) continue;
      if (fresh.length) return { status: 'failed', file, reason: `herdr did not accept the shortcut: ${fresh.join('; ')}` };
      const backup = existed ? `${file}.foreman-backup` : null;
      if (backup) d.writeFile(backup, text);
      d.writeFile(file, candidate);
      return { status: 'added', file, key, prefix: keys.prefix, backup };
    }
  } catch (err) {
    return { status: 'failed', file, reason: notInstalled(err) };
  } finally {
    try {
      d.removeFile(candidateFile);
    } catch {
      // already gone
    }
  }
  return { status: 'failed', file, reason: `the keys ${KEY_CHOICES.join(', ')} are all taken` };
}

// ---- Herdr desktop app: a mod with the task prompt and one key in keys.json ----

export function appHome({ env, homedir }) {
  return env.HERDR_APP_HOME || path.join(homedir, '.config', 'herdr-app');
}

const sha = (text) => createHash('sha256').update(text).digest('hex');
const forward = (p) => p.replace(/\\/g, '/');

// The mod's files with this machine's node and foreman paths filled in; main.js
// starts with a marker holding the version and a hash of the rest.
export function renderAppMod(d, version) {
  const root = d.root ?? PACKAGE_ROOT;
  const template = d.readFile(path.join(root, 'app', APP_MOD, 'main.js'));
  const body = template
    .replace('"__NODE__"', () => JSON.stringify(forward(d.nodePath ?? process.execPath)))
    .replace('"__BIN__"', () => JSON.stringify(forward(path.join(root, 'bin', 'foreman.js'))));
  return {
    main: `// foreman-managed ${version} ${sha(body)}\n${body}`,
    modJson: d.readFile(path.join(root, 'app', APP_MOD, 'mod.json')),
    logo: d.readFile(path.join(root, 'app', APP_MOD, 'logo.svg')),
  };
}

// A rendered main.js without its marker and this machine's paths.
const withoutPaths = (main) => main.replace(APP_MARKER, '').replace(/^const (NODE|BIN) = "[^"\n]*";/gm, 'const $1 = "";');

async function appCheck(d, main, modJson, logo) {
  const dir = path.join(d.tmpdir, 'foreman-app-mod-check', APP_MOD);
  const files = [path.join(dir, 'main.js'), path.join(dir, 'mod.json'), path.join(dir, 'logo.svg')];
  try {
    d.writeFile(files[0], main);
    d.writeFile(files[1], modJson);
    d.writeFile(files[2], logo);
    const res = await d.run('herdr-app', ['check', dir], { env: d.env, cwd: d.tmpdir, timeoutMs: 30000 });
    if (res.code === 0) return null;
    const last = `${res.stdout}\n${res.stderr}`.trim().split(/\r?\n/).filter(Boolean).pop();
    return `herdr-app check failed: ${last ?? `exit ${res.code}`}`;
  } catch (err) {
    return err.code === 'ENOENT' ? 'the herdr-app command is not on PATH' : `herdr-app check failed: ${err.message}`;
  } finally {
    for (const f of files) {
      try {
        d.removeFile(f);
      } catch {
        // already gone
      }
    }
  }
}

// True when dir is foreman's worktrees folder or inside it.
export function insideWorktrees(d, dir) {
  const worktrees = d.paths?.worktrees ?? paths({ env: d.env ?? {}, homedir: d.homedir }).worktrees;
  const rel = path.relative(path.resolve(worktrees), path.resolve(dir));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Add or update mods/foreman in the Herdr app. Only a file foreman wrote and
// the user did not touch is ever replaced; a candidate is checked by herdr-app first.
export async function installAppMod(d, version) {
  const dir = path.join(appHome(d), 'mods', APP_MOD);
  const mainFile = path.join(dir, 'main.js');
  // A copy of foreman inside one of its own task worktrees goes away when the
  // task ends; a prompt pointing at it would then only say "foreman moved".
  const root = d.root ?? PACKAGE_ROOT;
  if (insideWorktrees(d, root)) {
    return { status: 'skipped', dir, reason: `foreman runs from a task worktree (${root}), which is removed when the task ends, so the task prompt is left as is: run "foreman setup" from the installed foreman` };
  }
  let want;
  try {
    want = renderAppMod(d, version);
  } catch (err) {
    return { status: 'failed', dir, reason: `cannot read foreman's app files: ${err.message}` };
  }
  let have = null;
  try {
    have = d.readFile(mainFile);
  } catch (err) {
    if (err.code !== 'ENOENT') return { status: 'failed', dir, reason: `cannot read ${mainFile}: ${err.message}` };
  }
  const logoFile = path.join(dir, 'logo.svg');
  let haveLogo = null;
  try {
    haveLogo = d.readFile(logoFile);
  } catch {
    // missing: written below
  }
  if (have === want.main && haveLogo === want.logo) return { status: 'already', dir };
  if (have !== null) {
    const marker = have.match(APP_MARKER);
    if (!marker || sha(have.slice(marker[0].length)) !== marker[2]) {
      return { status: 'skipped', dir, reason: `${mainFile} was not written by foreman or was changed, so it is left alone` };
    }
    // Several copies of foreman (the herdr plugin, npm, a clone) each run
    // setup. The mod stays with the copy it runs while that copy exists: an
    // older copy never puts its prompt back, and one of the same version only
    // differs in where node and foreman are, which is no reason to rewrite it.
    const bin = have.match(/^const BIN = ("[^"\n]*");/m);
    if (bin && d.exists(path.normalize(JSON.parse(bin[1])))) {
      const order = compareVersions(marker[1], version);
      if (order > 0) return { status: 'newer', dir, version: marker[1] };
      if (order === 0 && withoutPaths(have) === withoutPaths(want.main)) {
        if (haveLogo === want.logo) return { status: 'already', dir };
        d.writeFile(logoFile, want.logo);
        return { status: 'updated', dir };
      }
    }
  } else if (d.exists(dir)) {
    return { status: 'skipped', dir, reason: `${dir} exists and is not foreman's, so it is left alone` };
  }
  const problem = await appCheck(d, want.main, want.modJson, want.logo);
  if (problem) return { status: 'failed', dir, reason: problem };
  d.writeFile(path.join(dir, 'mod.json'), want.modJson);
  d.writeFile(logoFile, want.logo);
  d.writeFile(mainFile, want.main);
  return { status: have === null ? 'added' : 'updated', dir };
}

// Bind a key to the prompt in keys.json unless some key already opens it. An
// edited keys.json is the person's whole key set, so a missing or unreadable
// one is never created or replaced.
export async function bindAppKey(d) {
  const home = appHome(d);
  const file = path.join(home, 'keys.json');
  let text;
  try {
    text = d.readFile(file);
  } catch (err) {
    const reason = err.code === 'ENOENT' ? `${file} does not exist yet; open the Herdr app once, then type "foreman setup"` : `cannot read ${file}: ${err.message}`;
    return { status: 'skipped', file, reason };
  }
  let keys;
  try {
    keys = JSON.parse(text);
    if (!keys || typeof keys !== 'object' || Array.isArray(keys)) throw new Error('not an object');
  } catch {
    return { status: 'skipped', file, reason: `${file} is not valid JSON, so it is left alone` };
  }
  const global = keys.global && typeof keys.global === 'object' ? keys.global : {};
  const opens = (a) => a === APP_ACTION || (a?.command === 'mod.open' && a.args?.name === APP_MOD);
  const ours = Object.keys(global).find((k) => opens(global[k]));
  if (ours) return { status: 'already', file, key: ours };
  const taken = new Set(Object.values(keys).flatMap((s) => (s && typeof s === 'object' ? Object.keys(s) : [])).map((k) => k.toLowerCase()));
  const key = APP_KEY_CHOICES.find((k) => !taken.has(k));
  if (!key) return { status: 'failed', file, reason: `the keys ${APP_KEY_CHOICES.join(', ')} are all taken` };
  const backup = `${file}.foreman-backup`;
  const errorFile = path.join(home, 'keys.error');
  const hadError = d.exists(errorFile);
  d.writeFile(backup, text);
  d.writeFile(file, `${JSON.stringify({ ...keys, global: { ...global, [key]: APP_ACTION } }, null, 2)}\n`);
  // The running app re-reads keys.json within a second and says why it refused it.
  await (d.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(1500);
  if (!hadError && d.exists(errorFile)) {
    d.writeFile(file, text);
    return { status: 'failed', file, reason: `the Herdr app did not accept the key (see ${errorFile}); your keys are back as they were` };
  }
  return { status: 'added', file, key, backup };
}

// Everything for the desktop app; nothing is written when the app has no home folder yet.
export async function setupApp(d, version) {
  const home = appHome(d);
  if (!d.exists(home)) return { status: 'absent', home };
  const mod = await installAppMod(d, version);
  const key = ['added', 'updated', 'already', 'newer'].includes(mod.status) ? await bindAppKey(d) : { status: 'skipped' };
  return { status: 'found', home, mod, key };
}

export const humanAppKey = (key) => chord(key.replace(/-/g, '+'));

// Apply config.toml to a running server; false when no server runs (herdr
// reads the file when it starts).
export async function reloadConfig({ run, env }) {
  const status = await run('herdr', ['status', 'server'], { env, timeoutMs: 10000 }).catch(() => null);
  if (!status || !/status:\s*running/.test(status.stdout)) return false;
  const res = await run('herdr', ['server', 'reload-config'], { env, timeoutMs: 15000 }).catch(() => null);
  return res?.code === 0;
}

// enabled | disabled | missing | unknown
export async function pluginState({ run, env }) {
  try {
    const res = await run('herdr', ['plugin', 'list', '--json'], { env, timeoutMs: 15000 });
    const body = JSON.parse(res.stdout);
    const plugins = body.result?.plugins ?? body.plugins;
    if (!Array.isArray(plugins)) return 'unknown';
    const p = plugins.find((x) => (x.id ?? x.plugin_id) === PLUGIN_ID);
    if (!p) return 'missing';
    return p.enabled === false || p.state === 'disabled' ? 'disabled' : 'enabled';
  } catch {
    return 'unknown';
  }
}

export function chooseLeader({ configured, agents }) {
  if (configured) return { leader: configured, changed: false };
  const ready = agents.filter((a) => a.status === 'ready').map((a) => a.kind);
  const pool = ready.length ? ready : agents.map((a) => a.kind);
  const leader = LEADER_ORDER.find((k) => pool.includes(k)) ?? pool[0] ?? null;
  return { leader, changed: Boolean(leader) && leader !== DEFAULT_CONFIG.leader };
}

function readUserConfig({ paths, readFile }) {
  try {
    return JSON.parse(readFile(paths.config));
  } catch {
    return {};
  }
}

async function firstLine(run, cmd, args, opts) {
  try {
    const res = await run(cmd, args, { timeoutMs: 15000, ...opts });
    return res.code === 0 ? (res.stdout.trim().split(/\r?\n/)[0] ?? '') : null;
  } catch {
    return null;
  }
}

// herdr-core on its own (hc): its version, and whether its server answers.
// With neither herdr nor the desktop app this is still a place to run tasks,
// reached from a terminal or from the Herdr phone app.
export async function coreState(d) {
  let hc = null;
  try {
    hc = findTool('hc', d);
  } catch {
    // no way to look for it
  }
  if (!hc) return { version: null, running: false };
  const line = await firstLine(d.run, hc, ['--version'], { env: d.env });
  if (line === null) return { version: null, running: false };
  const status = await d.run(hc, ['server', 'status', '--json'], { env: d.env, timeoutMs: 10000 }).catch(() => null);
  return { version: line.replace(/^hc\s+/, '') || 'unknown', running: status?.code === 0 };
}

// Inside node_modules (an npm install) or a global npm install, not a
// developer's own clone running `npm install`.
export function installedByNpm({ env, root = PACKAGE_ROOT }) {
  return env.npm_config_global === 'true' || root.split(/[\\/]/).includes('node_modules');
}

// d: run, which, env, cwd, homedir, platform, paths, readFile, writeFile,
// removeFile, exists, tmpdir, inventory, nodeVersion, root.
// quiet: only fix what is cheap (shortcut, lead agent), no agent probes.
export async function runSetup(d, { quiet = false, postinstall = false } = {}) {
  const env = d.env;
  const root = d.root ?? PACKAGE_ROOT;
  // A developer's `npm install` in a clone changes nothing.
  if (postinstall && !installedByNpm({ env, root })) return { quiet: true, skipped: true, changes: [], key: { status: 'skipped' }, ok: true };
  const r = { quiet, changes: [] };

  r.node = { version: d.nodeVersion, ok: Number(String(d.nodeVersion).split('.')[0]) >= MIN_NODE };
  const herdrVersion = await firstLine(d.run, 'herdr', ['--version'], { env });
  r.herdr = { version: herdrVersion?.replace(/^herdr\s+/, '') ?? null, ok: Boolean(herdrVersion) && versionAtLeast(herdrVersion, MIN_HERDR) };

  if (r.herdr.version) {
    r.plugin = await pluginState(d);
    const mayLink = postinstall || !quiet;
    if (r.plugin === 'missing' && mayLink && d.exists(path.join(root, 'herdr-plugin.toml'))) {
      const res = await d.run('herdr', ['plugin', 'link', root], { env, timeoutMs: 30000 }).catch((err) => ({ code: 1, stderr: err.message }));
      if (res.code === 0) {
        r.plugin = 'enabled';
        r.linked = true;
        r.changes.push('added itself to herdr');
      } else {
        r.pluginError = (res.stderr || res.stdout || '').trim().split(/\r?\n/)[0];
      }
    }
    r.key = await bindKey(d);
    if (r.key.status === 'added') {
      r.key.reloaded = await reloadConfig(d);
      r.changes.push(`added the shortcut ${humanKey(r.key.key, r.key.prefix)} to herdr`);
    }
  } else {
    r.plugin = 'unknown';
    r.key = { status: 'failed', reason: 'herdr is not installed' };
  }

  let version = '0';
  try {
    version = JSON.parse(d.readFile(path.join(root, 'package.json'))).version ?? version;
  } catch {
    // an unversioned copy still installs
  }
  try {
    r.app = await setupApp({ ...d, root }, version);
  } catch (err) {
    r.app = { status: 'found', mod: { status: 'failed', reason: err.message }, key: { status: 'skipped' } };
  }
  if (r.app.status === 'found') {
    const { mod, key } = r.app;
    if (mod.status === 'added' || mod.status === 'updated') r.changes.push(`${mod.status} its task prompt in the Herdr app`);
    if (key.status === 'added') r.changes.push(`added the shortcut ${humanAppKey(key.key)} to the Herdr app`);
  }

  // Quiet runs ask herdr-core only when nothing else is there to run tasks in.
  if (!quiet || (!r.herdr.version && r.app.status === 'absent')) r.core = await coreState(d);
  r.coreOnly = !r.herdr.version && r.app.status === 'absent' && Boolean(r.core?.running);

  if (!quiet) {
    const gitVersion = await firstLine(d.run, 'git', ['--version'], { env });
    const name = gitVersion ? await firstLine(d.run, 'git', ['config', 'user.name'], { env, cwd: d.cwd }) : null;
    const email = gitVersion ? await firstLine(d.run, 'git', ['config', 'user.email'], { env, cwd: d.cwd }) : null;
    r.git = { version: gitVersion?.replace(/^git version\s+/, '') ?? null, name: name || null, hasEmail: Boolean(email) };
  }

  // Quiet runs only look at what is installed; a full run asks each agent
  // whether it is signed in.
  r.agents = quiet
    ? HERDR_KINDS.filter((k) => d.which(k)).map((kind) => ({ kind, status: 'installed', models: [], reason: null }))
    : await d.inventory();
  const user = readUserConfig(d);
  const choice = chooseLeader({ configured: user.leader ?? null, agents: r.agents });
  r.leader = choice.leader;
  r.configFile = d.paths.config;
  if (choice.changed) {
    d.writeFile(d.paths.config, `${JSON.stringify({ ...user, leader: choice.leader }, null, 2)}\n`);
    r.leaderChosen = true;
    r.changes.push(`chose ${choice.leader} as the lead agent`);
  }

  const appOk = r.app.status === 'found' && ['added', 'updated', 'already', 'newer'].includes(r.app.mod.status) && ['added', 'already'].includes(r.app.key.status);
  const herdrOk = r.herdr.ok && r.plugin === 'enabled' && ['added', 'already'].includes(r.key.status);
  if (['added', 'already'].includes(r.key.status) || appOk || r.coreOnly) {
    const state = { at: new Date().toISOString() };
    if (['added', 'already'].includes(r.key.status)) Object.assign(state, { key: r.key.key, file: r.key.file });
    if (appOk) state.app = { key: r.app.key.key, mod: version };
    if (r.coreOnly) state.core = r.core.version;
    d.writeFile(d.paths.setupState, `${JSON.stringify(state)}\n`);
  }

  // The launcher terminal, for someone who asked for it in config.json.
  if (d.ensureLauncher) {
    r.launcher = await Promise.resolve().then(() => d.ensureLauncher()).catch(() => null);
    if (r.launcher?.status === 'started') r.changes.push('opened its launcher terminal for the Herdr phone app');
  }

  const leaderReady = r.agents.some((a) => a.kind === r.leader && a.status === 'ready');
  // herdr itself is optional for someone who only uses the Herdr app, the app for someone who only
  // uses herdr, and both for someone who has herdr-core alone (a server, the Herdr phone app).
  const where = r.herdr.version ? herdrOk && (r.app.status === 'absent' || appOk) : appOk || r.coreOnly;
  r.ok = r.node.ok && where
    && Boolean(r.git?.version) && Boolean(r.git?.name) && r.git?.hasEmail && leaderReady;
  return r;
}

// An agent's state in words a newcomer can act on.
export function describeAgent(a) {
  if (a.status === 'ready') return `${a.kind} is ready`;
  const cmd = a.reason?.match(/"([^"]+)"/)?.[1];
  if (/not signed in|no models|add a provider/.test(a.reason ?? '') && cmd) {
    return `${a.kind} is installed but not signed in. To sign in, open a terminal and type: ${cmd}`;
  }
  return `${a.kind} is installed but foreman cannot tell if it works${a.reason ? ` (${a.reason})` : ''}`;
}

export function formatSetup(r, ui = createUi()) {
  const out = [];
  let passed = 0;
  let failed = 0;
  const ok = (text) => { passed++; out.push(`  ${ui.green('[ok]')} ${text}`); };
  const todo = (text) => { failed++; out.push(`  ${ui.red('[!!]')} ${text}`); };

  if (r.quiet) {
    for (const c of r.changes) out.push(`foreman ${c}.`);
    if (r.app?.status === 'found') {
      for (const x of [r.app.mod, r.app.key]) if (x.status === 'failed') out.push(`foreman could not set up the Herdr app: ${x.reason}. Type "foreman setup" for help.`);
    }
    if (r.key.status === 'failed' && r.herdr?.version) out.push(`foreman could not add its shortcut to herdr: ${r.key.reason}. Type "foreman setup" for help.`);
    return out.join('\n');
  }

  out.push('foreman setup', '');
  if (r.node.ok) ok(`Node.js ${r.node.version}`);
  else todo(`Node.js ${r.node.version} is too old. Install version ${MIN_NODE} or newer from https://nodejs.org`);

  const hasApp = r.app?.status === 'found';
  const core = r.core?.version ? r.core : null;
  if (!r.herdr.version && hasApp) ok('herdr (the terminal version) is not installed, which is fine for the Herdr app');
  else if (!r.herdr.version && core?.running) ok(`herdr-core ${core.version} is running. herdr and the Herdr desktop app are not installed, which is fine: tasks start from a terminal here or from the Herdr phone app`);
  else if (!r.herdr.version && core) todo(`herdr-core ${core.version} is installed but does not answer. Type: hc server start, then "foreman setup" again`);
  else if (!r.herdr.version) todo('herdr is not installed. Install it from https://herdr.dev, then type "foreman setup" again');
  else if (!r.herdr.ok) todo(`herdr ${r.herdr.version} is too old. Type "herdr update" to get version ${MIN_HERDR} or newer`);
  else ok(`herdr ${r.herdr.version}`);

  if (!r.git?.version) todo('git is not installed. Install it from https://git-scm.com');
  else if (!r.git.name || !r.git.hasEmail) todo('git does not know your name yet; foreman needs it to save the work. Type: git config --global user.name "Your Name" and git config --global user.email "you@example.com"');
  else ok(`git ${r.git.version}, saving work as ${r.git.name}`);

  if (!r.herdr.version && hasApp) {
    // nothing to add to herdr
  } else if (r.plugin === 'enabled') ok(`foreman is added to herdr${r.linked ? ' (just now)' : ''}`);
  else if (r.plugin === 'disabled') todo(`foreman is turned off in herdr. Type: herdr plugin enable ${PLUGIN_ID}`);
  else if (r.plugin === 'missing') todo(`foreman is not added to herdr yet, so the shortcut will not work. Type: herdr plugin install Kvmyk/herdr-foreman${r.pluginError ? ` (${r.pluginError})` : ''}`);
  else if (r.herdr.version) todo('herdr did not say whether foreman is added; type "herdr plugin list" to check');

  const k = r.key;
  if (k.status === 'already') ok(`Shortcut: ${humanKey(k.key, k.prefix)}`);
  else if (k.status === 'added') {
    ok(`Shortcut: ${humanKey(k.key, k.prefix)} (just added to ${k.file}${k.backup ? `; your old settings are saved as ${k.backup}` : ''})`);
    if (!k.reloaded) out.push('       It works the next time herdr starts.');
  } else if (r.herdr.version) todo(`foreman could not add its shortcut: ${k.reason}`);

  if (hasApp) {
    const { mod, key } = r.app;
    if (mod.status === 'failed') todo(`foreman could not add its task prompt to the Herdr app: ${mod.reason}`);
    else if (mod.status === 'skipped') todo(`Herdr app: ${mod.reason}`);
    else if (mod.status === 'newer') ok(`Herdr app: task prompt is installed by a newer foreman (${mod.version}), so it is left as is`);
    else ok(`Herdr app: task prompt ${mod.status === 'already' ? 'is installed' : `${mod.status} (${mod.dir})`}`);
    if (key.status === 'already') ok(`Herdr app shortcut: ${humanAppKey(key.key)}`);
    else if (key.status === 'added') ok(`Herdr app shortcut: ${humanAppKey(key.key)} (just added to ${key.file}; your old keys are saved as ${key.backup})`);
    else if (key.status !== 'skipped') todo(`foreman could not add its shortcut to the Herdr app: ${key.reason}`);
  }

  if (['started', 'already'].includes(r.launcher?.status)) ok(`Launcher: a terminal named foreman is open${r.launcher.status === 'started' ? ' (just now)' : ''}; in the Herdr phone app it is in the Inbox`);
  else if (r.launcher?.status === 'failed' || r.launcher?.status === 'no-core') todo(`The launcher ("launcher": true in ${r.configFile}) could not start: ${r.launcher.reason}`);

  if (!r.agents.length) todo('No coding agent found. Install one, for example Claude Code (https://claude.com/claude-code) or Codex (https://developers.openai.com/codex), and sign in');
  for (const a of r.agents) (a.status === 'ready' ? ok : todo)(describeAgent(a));
  const leaderReady = r.agents.some((a) => a.kind === r.leader && a.status === 'ready');
  if (r.leader && leaderReady) ok(`Lead agent: ${r.leader}${r.leaderChosen ? ` (chosen just now; saved in ${r.configFile})` : ''}`);
  else if (r.leader) todo(`The lead agent ${r.leader} is not ready (see above). To use another one, put {"leader": "<agent>"} in ${r.configFile}`);

  out.push('', `${passed} of ${passed + failed} checks passed`, '');
  const appKey = hasApp && ['added', 'already'].includes(r.app.key.status) ? humanAppKey(r.app.key.key) : null;
  if (r.ok && r.coreOnly) {
    out.push(
      'What to do next, in the Herdr phone app or in any terminal on this computer:',
      '  1. Open a terminal in your project folder.',
      '  2. Type: foreman new',
      '  3. Paste or type what you want done and press Enter.',
    );
  } else if (r.ok && !['added', 'already'].includes(k.status)) {
    out.push(
      'What to do next:',
      '  1. In the Herdr app, open a terminal in your project folder.',
      `  2. Press ${appKey}.`,
      '  3. Type what you want done and press Enter or Start.',
    );
  } else if (r.ok) {
    const key = humanKey(k.key, k.prefix);
    out.push(
      'What to do next:',
      '  1. Open a terminal in your project folder and type: herdr',
      `  2. Press ${key.replace(', then ', ', let go, then press ')}.`,
      '  3. Type what you want done and press Enter. An empty line cancels.',
    );
    if (appKey) out.push(`  In the Herdr app, open a terminal in your project folder and press ${appKey} instead.`);
  } else {
    out.push(`Fix the lines marked ${ui.red('[!!]')}, then type "foreman setup" again.`);
  }
  // The phone app reaches whatever runs in herdr-core: that, and nothing else.
  if (r.ok && r.core?.running) {
    if (!r.coreOnly) out.push('  From the Herdr phone app: open a terminal in your project folder and type: foreman new');
    if (['started', 'already'].includes(r.launcher?.status)) out.push('  Or open the terminal named foreman in the phone\'s Inbox and send the task there.');
    else out.push('  To keep a foreman terminal in the phone\'s Inbox, type: foreman launcher on');
  }
  return out.join('\n');
}
