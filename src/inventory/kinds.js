// What foreman knows about each agent kind herdr can start: how to tell
// whether it can work right now (signed in, has models) and how to pass a model.
import path from 'node:path';

export const HERDR_KINDS = Object.freeze([
  'pi', 'claude', 'codex', 'gemini', 'cursor', 'devin', 'agy', 'cline', 'omp', 'mastracode',
  'opencode', 'copilot', 'kimi', 'kiro', 'droid', 'amp', 'grok', 'hermes', 'kilo', 'qodercli',
  'qwen', 'letta', 'maki', 'muse',
]);

const ANSI = /\x1b\[[0-9;]*m/g;
const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio', 'llamacpp', 'llama.cpp', 'local']);

export function accessForModel(id) {
  const provider = id.split('/')[0];
  if (provider === 'github-copilot') return 'subscription';
  if (LOCAL_PROVIDERS.has(provider)) return 'local';
  if (provider === 'opencode' && /-free$/.test(id)) return 'free';
  return 'api';
}

const lines = (text) => text.replace(ANSI, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const ready = (models, defaultModel = null) => ({ status: 'ready', reason: null, models, defaultModel });
const unavailable = (reason) => ({ status: 'unavailable', reason, models: [], defaultModel: null });
const firstLine = (res) => lines(res.stderr || res.stdout)[0] ?? `exit code ${res.code}`;

async function probeClaude({ run, readJson, home, timeoutMs }) {
  const res = await run('claude', ['auth', 'status'], { timeoutMs });
  let status;
  try {
    status = JSON.parse(res.stdout);
  } catch {
    return unavailable(`cannot read "claude auth status": ${firstLine(res)}`);
  }
  if (!status.loggedIn) return unavailable('not signed in; run "claude auth login"');
  const access = status.authMethod === 'claude.ai' ? 'subscription' : 'api';
  const settings = readJson(path.join(home, '.claude', 'settings.json'));
  return ready(['opus', 'sonnet', 'haiku'].map((id) => ({ id, access })), settings?.model ?? null);
}

// agy >= 1.5 prints "slug<TAB>Display name"; older versions print the name only.
async function probeAgy({ run, readJson, home, timeoutMs }) {
  const res = await run('agy', ['models'], { timeoutMs });
  const rows = res.code === 0 ? res.stdout.replace(ANSI, '').split(/\r?\n/).filter((l) => l.trim() && !/\.\.\.\s*$/.test(l)) : [];
  const models = rows.map((l) => {
    const [id, name] = l.split('\t').map((s) => s.trim());
    return name ? { id, name, access: 'subscription' } : { id, access: 'subscription' };
  });
  if (!models.length) return unavailable(`no models; sign in by running "agy" (${firstLine(res)})`);
  const configured = readJson(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'))?.model ?? null;
  const match = models.find((m) => m.name === configured || m.id === configured);
  if (configured && !match) {
    return { ...ready(models, null), reason: `configured model "${configured}" is not offered any more; pass a model explicitly` };
  }
  return ready(models, match?.id ?? null);
}

async function probeOpencode({ run, readJson, home, timeoutMs }) {
  const res = await run('opencode', ['models'], { timeoutMs });
  const ids = res.code === 0 ? lines(res.stdout).filter((l) => /^[\w.-]+\/\S+$/.test(l)) : [];
  if (!ids.length) return unavailable(`no models; add a provider with "opencode auth login" (${firstLine(res)})`);
  const recent = readJson(path.join(home, '.local', 'state', 'opencode', 'model.json'))?.recent?.[0];
  const defaultModel = recent ? `${recent.providerID}/${recent.modelID}` : null;
  return ready(ids.map((id) => ({ id, access: accessForModel(id) })), defaultModel);
}

async function probePi({ run, readJson, home, timeoutMs }) {
  const res = await run('pi', ['--list-models'], { timeoutMs });
  const rows = lines(res.stdout);
  const header = rows.findIndex((l) => /^provider\s+model\b/.test(l));
  const ids = header < 0 ? [] : rows.slice(header + 1).map((l) => l.split(/\s+/)).filter((c) => c.length >= 2).map(([p, m]) => `${p}/${m}`);
  if (!ids.length) return unavailable('no models with working access; see "pi --list-models"');
  const s = readJson(path.join(home, '.pi', 'agent', 'settings.json'));
  const configured = s?.defaultProvider && s?.defaultModel ? `${s.defaultProvider}/${s.defaultModel}` : null;
  return ready(ids.map((id) => ({ id, access: accessForModel(id) })), configured ?? ids[0]);
}

async function probeGemini({ env, exists, home }) {
  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.GOOGLE_GENAI_USE_VERTEXAI) return ready([]);
  const ended = 'personal Gemini CLI access ended on 2026-06-18; use agy or set GEMINI_API_KEY';
  if (exists(path.join(home, '.gemini', 'oauth_creds.json'))) return unavailable(ended);
  return unavailable(`not signed in; ${ended}`);
}

async function probeCodex({ run, timeoutMs }) {
  const res = await run('codex', ['login', 'status'], { timeoutMs });
  if (res.code !== 0) return unavailable(`not signed in; run "codex login" (${firstLine(res)})`);
  return ready([]);
}

const flag = (name) => (value) => [name, value];

// Claude Code starts with ~26k tokens of context per turn; without MCP servers,
// skills and unused tools it is ~14k (measured 2026-11-07). Every turn re-sends it.
const CLAUDE_LEAN = ['--strict-mcp-config', '--disable-slash-commands', '--tools'];
const CLAUDE_TOOLS = 'Bash,Read,Glob,Grep,Edit,Write';

export const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

export const PROBES = Object.freeze({
  claude: {
    probe: probeClaude,
    modelArgs: flag('--model'),
    effortArgs: flag('--effort'),
    // Answers permission prompts itself; pushes and gh (pull requests) stay denied.
    autoArgs: ['--permission-mode', 'auto', '--disallowedTools', 'Bash(git push:*),Bash(gh:*)'],
    autoFlag: '--permission-mode',
    leanArgs: { leader: [...CLAUDE_LEAN, `${CLAUDE_TOOLS},AskUserQuestion`], worker: [...CLAUDE_LEAN, CLAUDE_TOOLS] },
    verified: true,
  },
  // agy takes its effort from the model id; with --model, --effort makes it ignore the model.
  agy: {
    probe: probeAgy, modelArgs: flag('--model'), effortArgs: flag('--effort'), effortFromModel: true,
    autoArgs: ['--mode', 'auto'], autoFlag: '--mode', verified: true,
  },
  opencode: { probe: probeOpencode, modelArgs: flag('--model'), listsModels: true, autoArgs: ['--auto'], autoFlag: '--auto', verified: true },
  // pi never asks for permission.
  pi: { probe: probePi, modelArgs: flag('--model'), listsModels: true, autoArgs: [], verified: true },
  gemini: { probe: probeGemini, modelArgs: flag('-m'), verified: true },
  codex: { probe: probeCodex, modelArgs: flag('-m'), verified: false },
});
