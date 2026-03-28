import { resolveAvailableCliCommand } from './cliResolution.js';

let resolvedCodexCliCommandPromise = null;

export async function resolveCodexCliCommand() {
  if (!resolvedCodexCliCommandPromise) {
    resolvedCodexCliCommandPromise = resolveAvailableCliCommand({
      envVarName: 'CODEX_CLI_PATH',
      defaultCommands: ['codex'],
      appendWindowsSuffixes: true,
    });
  }

  try {
    return await resolvedCodexCliCommandPromise;
  } catch (error) {
    resolvedCodexCliCommandPromise = null;
    throw error;
  }
}
