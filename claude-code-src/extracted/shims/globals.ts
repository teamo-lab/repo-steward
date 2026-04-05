// Build-time macros polyfill for edward build
(globalThis as any).MACRO = {
  VERSION: '1.0.25',
  BUILD_TIME: new Date().toISOString(),
  ISSUES_EXPLAINER: 'report the issue at https://github.com/teamo-lab/repo-steward/issues',
  FEEDBACK_CHANNEL: 'https://github.com/teamo-lab/repo-steward/issues',
};
