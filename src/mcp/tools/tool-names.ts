/**
 * Canonical list of Tenet MCP tool names.
 *
 * Used by `tenet init` to pre-approve tools in host agent configs
 * (Claude Code settings.local.json, OpenCode opencode.json, Codex config.toml).
 *
 * Keep in sync with the registrations in `./index.ts`. There's a test that
 * asserts this list matches the registered tools so divergence fails CI.
 */
export const TENET_MCP_TOOL_NAMES = [
  'tenet_init',
  'tenet_continue',
  'tenet_compile_context',
  'tenet_start_job',
  'tenet_register_jobs',
  'tenet_job_wait',
  'tenet_job_result',
  'tenet_cancel_job',
  'tenet_start_eval',
  'tenet_validate_clarity',
  'tenet_validate_readiness',
  'tenet_update_knowledge',
  'tenet_add_steer',
  'tenet_process_steer',
  'tenet_health_check',
  'tenet_get_status',
  'tenet_retry_job',
  'tenet_request_remediation',
] as const;

export type TenetMcpToolName = (typeof TENET_MCP_TOOL_NAMES)[number];
