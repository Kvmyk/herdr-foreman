// Start flags foreman passes to an agent are checked once against the agent's
// own --help, so an agent that dropped a flag is named before it fails to start.

const FLAG = /^--?[A-Za-z]/;

export const flagsOf = (args) => [...new Set(args.filter((a) => FLAG.test(a)))];

// byKind: Map kind -> flags. Returns warnings for flags the help does not mention.
export async function checkStartFlags({ run, byKind }) {
  const warnings = [];
  for (const [kind, flags] of byKind) {
    if (!flags.length) continue;
    const help = await run(kind, ['--help'], { timeoutMs: 15000 }).catch(() => null);
    if (!help) continue;
    const text = `${help.stdout}\n${help.stderr}`;
    for (const flag of flags) {
      if (!text.includes(flag)) warnings.push(`"${kind} --help" does not mention ${flag}; ${kind} may fail to start or ignore it`);
    }
  }
  return warnings;
}
