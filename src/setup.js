// Setting foreman up so nobody has to: add foreman to herdr, bind the
// shortcut in herdr's config.toml, pick a lead agent that is installed, and
// say in plain words what works and what to do next.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from './config.js';
import { HERDR_KINDS } from './inventory/kinds.js';

export const PLUGIN_ID = 'herdr-foreman';
export const ACTION = `${PLUGIN_ID}.start`;
// None of these is a herdr default; the first one the user's config leaves free wins.
export const KEY_CHOICES = Object.freeze(['prefix+f', 'prefix+shift+f', 'prefix+alt+f']);
export const MIN_HERDR = '0.9.5';
export const MIN_NODE = 20;
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

  if (['added', 'already'].includes(r.key.status)) {
    d.writeFile(d.paths.setupState, `${JSON.stringify({ key: r.key.key, file: r.key.file, at: new Date().toISOString() })}\n`);
  }

  const leaderReady = r.agents.some((a) => a.kind === r.leader && a.status === 'ready');
  r.ok = r.node.ok && r.herdr.ok && r.plugin === 'enabled' && ['added', 'already'].includes(r.key.status)
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

export function formatSetup(r) {
  const out = [];
  const ok = (text) => out.push(`  [ok] ${text}`);
  const todo = (text) => out.push(`  [!!] ${text}`);

  if (r.quiet) {
    for (const c of r.changes) out.push(`foreman ${c}.`);
    if (r.key.status === 'failed' && r.herdr?.version) out.push(`foreman could not add its shortcut to herdr: ${r.key.reason}. Type "foreman setup" for help.`);
    return out.join('\n');
  }

  out.push('foreman setup', '');
  if (r.node.ok) ok(`Node.js ${r.node.version}`);
  else todo(`Node.js ${r.node.version} is too old. Install version ${MIN_NODE} or newer from https://nodejs.org`);

  if (!r.herdr.version) todo('herdr is not installed. Install it from https://herdr.dev, then type "foreman setup" again');
  else if (!r.herdr.ok) todo(`herdr ${r.herdr.version} is too old. Type "herdr update" to get version ${MIN_HERDR} or newer`);
  else ok(`herdr ${r.herdr.version}`);

  if (!r.git?.version) todo('git is not installed. Install it from https://git-scm.com');
  else if (!r.git.name || !r.git.hasEmail) todo('git does not know your name yet; foreman needs it to save the work. Type: git config --global user.name "Your Name" and git config --global user.email "you@example.com"');
  else ok(`git ${r.git.version}, saving work as ${r.git.name}`);

  if (r.plugin === 'enabled') ok(`foreman is added to herdr${r.linked ? ' (just now)' : ''}`);
  else if (r.plugin === 'disabled') todo(`foreman is turned off in herdr. Type: herdr plugin enable ${PLUGIN_ID}`);
  else if (r.plugin === 'missing') todo(`foreman is not added to herdr yet, so the shortcut will not work. Type: herdr plugin install Kvmyk/herdr-foreman${r.pluginError ? ` (${r.pluginError})` : ''}`);
  else if (r.herdr.version) todo('herdr did not say whether foreman is added; type "herdr plugin list" to check');

  const k = r.key;
  if (k.status === 'already') ok(`Shortcut: ${humanKey(k.key, k.prefix)}`);
  else if (k.status === 'added') {
    ok(`Shortcut: ${humanKey(k.key, k.prefix)} (just added to ${k.file}${k.backup ? `; your old settings are saved as ${k.backup}` : ''})`);
    if (!k.reloaded) out.push('       It works the next time herdr starts.');
  } else if (r.herdr.version) todo(`foreman could not add its shortcut: ${k.reason}`);

  if (!r.agents.length) todo('No coding agent found. Install one, for example Claude Code (https://claude.com/claude-code) or Codex (https://developers.openai.com/codex), and sign in');
  for (const a of r.agents) (a.status === 'ready' ? ok : todo)(describeAgent(a));
  const leaderReady = r.agents.some((a) => a.kind === r.leader && a.status === 'ready');
  if (r.leader && leaderReady) ok(`Lead agent: ${r.leader}${r.leaderChosen ? ` (chosen just now; saved in ${r.configFile})` : ''}`);
  else if (r.leader) todo(`The lead agent ${r.leader} is not ready (see above). To use another one, put {"leader": "<agent>"} in ${r.configFile}`);

  out.push('');
  if (r.ok) {
    const key = humanKey(k.key, k.prefix);
    out.push(
      'What to do next:',
      '  1. Open a terminal in your project folder and type: herdr',
      `  2. Press ${key.replace(', then ', ', let go, then press ')}.`,
      '  3. Type what you want done and press Enter. An empty line cancels.',
    );
  } else {
    out.push('Fix the lines marked [!!], then type "foreman setup" again.');
  }
  return out.join('\n');
}
