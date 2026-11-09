// `foreman config`: the settings foreman runs with, and which ones you changed.
import { DEFAULT_CONFIG, loadConfig } from './config.js';

export function describeConfig({ paths, readFile, env = {} }) {
  const effective = loadConfig({ paths, readFile });
  // Settings an environment variable decides, shown with the value that is in effect.
  const overrides = {};
  if (env.FOREMAN_NO_SETUP) {
    effective.autoSetup = false;
    overrides.autoSetup = 'FOREMAN_NO_SETUP';
  }
  let exists = true;
  try {
    readFile(paths.config);
  } catch {
    exists = false;
  }
  const changed = Object.keys(effective).filter((k) => JSON.stringify(effective[k]) !== JSON.stringify(DEFAULT_CONFIG[k]));
  return { file: paths.config, exists, changed, overrides, config: effective };
}

export function formatConfig(c, ui) {
  const out = [`${c.exists ? 'Settings file' : 'No settings file yet; to change something, create'}: ${c.file}`, ''];
  const width = Math.max(...Object.keys(c.config).map((k) => k.length));
  for (const [k, v] of Object.entries(c.config)) {
    const mark = c.changed.includes(k) ? ui.cyan('*') : ' ';
    const by = c.overrides?.[k];
    out.push(`${mark} ${k.padEnd(width)}  ${JSON.stringify(v)}${by ? ui.dim(`  (set by the environment: ${by})`) : ''}`);
  }
  out.push('', ui.dim('* changed from the default'));
  return out.join('\n');
}
