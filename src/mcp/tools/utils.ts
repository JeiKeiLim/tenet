import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { JobType } from '../../types/index.js';

export const jsonResult = (data: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
});

export const okResult = (): CallToolResult => jsonResult({ ok: true });

export const asToolError = (error: unknown): CallToolResult => {
  const message = error instanceof Error ? error.message : 'unknown tool error';
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    isError: true,
  };
};

export const jobTypeSchema = z.enum(['dev', 'eval', 'mechanical_eval', 'compile_context', 'health_check']);

export const parseJobType = (value: string): JobType => {
  const parsed = jobTypeSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`invalid job_type: ${value}`);
  }

  return parsed.data;
};

export type RegisterTool = McpServer['registerTool'];
