/**
 * Jest `setupFiles` entry, run before each test file: this suite may itself
 * run inside an AI agent's shell (e.g. Claude Code sets `AI_AGENT`/
 * `CLAUDECODE`), which would otherwise make `agentMode()` default to true
 * everywhere. Scrub every marker so tests opt into agent mode explicitly.
 */
for ( const name of [
	'WP_REST_CLI_AGENT',
	'AI_AGENT',
	'CLAUDECODE',
	'CODEX_CI',
	'CODEX_SANDBOX',
	'CODEX_THREAD_ID',
	'COPILOT_AGENT',
	'COPILOT_ALLOW_ALL',
	'CLINE_ACTIVE',
	'CURSOR_AGENT',
] ) {
	delete process.env[ name ];
}
