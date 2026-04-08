export interface RestartSpec {
  command: string;
  args: string[];
}

interface RestartSpecOptions {
  execPath?: string;
  argv?: string[];
  moduleUrl?: string;
}

export function getRestartSpec(options: RestartSpecOptions = {}): RestartSpec {
  const execPath = options.execPath ?? process.execPath ?? "";
  const argv = options.argv ?? process.argv;
  const moduleUrl = options.moduleUrl ?? import.meta.url;
  const entrypoint = argv[1] ?? "";
  const userArgs = argv.slice(2);
  const isCompiledBinary = moduleUrl.includes("$bunfs") || entrypoint.startsWith("/$bunfs/");

  // Compiled Bun binaries expose an internal /$bunfs entry in argv[1].
  // Relaunch the real executable and only forward the user-facing args.
  if (isCompiledBinary) {
    return { command: execPath || argv[0] || "soulforge", args: userArgs };
  }

  if (entrypoint) {
    return { command: execPath || argv[0] || "bun", args: [entrypoint, ...userArgs] };
  }

  return { command: execPath || argv[0] || "soulforge", args: userArgs };
}
