#!/usr/bin/env bun
/**
 * Edward — proactive repo-maintenance agent (Repo Steward).
 *
 * CLI entrypoint. Dispatches to subcommands (gh/kubectl style).
 *
 * Usage:
 *   edward                             Show help
 *   edward serve                       Start dashboard server
 *   edward repos                       List tracked repos
 *   edward repos add owner/repo        Add a repo
 *   edward discover <repo> [--wait]    Trigger agent analysis
 *   edward suggestions <repo>          Show open suggestions
 *   edward approve|dismiss|snooze <task>
 *   edward help                        Full help
 *
 * Legacy flags (still supported):
 *   edward --dashboard-only            Alias for `edward serve`
 *   edward --version                   Alias for `edward version`
 */

import { runCli } from './cli.js';

const args = process.argv.slice(2);

// Legacy flag compatibility
if (args.includes('--dashboard-only')) {
  const code = await runCli(['serve']);
  process.exit(code);
}

if (args.includes('--version') || args.includes('-v')) {
  const code = await runCli(['version']);
  process.exit(code);
}

// Normal dispatch
const code = await runCli(args);
process.exit(code);
