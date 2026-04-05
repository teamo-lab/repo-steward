#!/usr/bin/env bun
/**
 * Edward — Repo Steward powered by Claude Code
 *
 * Usage:
 *   edward                  Start interactive mode + dashboard
 *   edward --dashboard-only Start dashboard server only (no CLI)
 *   edward -p "prompt"      Print mode (pass-through to Claude Code)
 *   edward --version        Show version
 */

import { startEdwardServer } from './server.js';

const args = process.argv.slice(2);

// Version
if (args.includes('--version') || args.includes('-v')) {
  console.log('0.1.0-edward (Repo Steward + Claude Code)');
  process.exit(0);
}

// Dashboard-only mode
if (args.includes('--dashboard-only')) {
  const port = parseInt(process.env.EDWARD_PORT || '8080', 10);
  startEdwardServer(port);
  console.log('[edward] Dashboard-only mode. Press Ctrl+C to stop.');
} else {
  // Start dashboard in background
  const port = parseInt(process.env.EDWARD_PORT || '8080', 10);
  startEdwardServer(port);

  // Pass through to Claude Code CLI
  process.argv = [process.argv[0]!, process.argv[1]!, ...args];
  await import('../entrypoints/cli.js');
}
