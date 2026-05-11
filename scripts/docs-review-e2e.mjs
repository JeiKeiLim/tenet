#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRepoRoot } from './docs-review.mjs';

const repoRoot = findRepoRoot();
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const docsReviewPath = path.join(scriptDir, 'docs-review.mjs');
const agents = process.env.DOCS_REVIEW_E2E_AGENTS || 'claude,codex';
const synthesizer = process.env.DOCS_REVIEW_E2E_SYNTHESIZER || 'claude';
const timeoutMinutes = process.env.DOCS_REVIEW_E2E_TIMEOUT_MINUTES || '30';
const outputDirEnv = process.env.DOCS_REVIEW_E2E_OUTPUT_DIR;
const shouldPrintMarkdown = ['1', 'true', 'yes'].includes(
  String(process.env.DOCS_REVIEW_E2E_PRINT_MARKDOWN || '').toLowerCase(),
);

const run = ({ command, args, cwd, timeoutMs }) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({
        code,
        stdout,
        stderr,
        timedOut,
      });
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      resolve({
        code: 1,
        stdout,
        stderr: `${stderr}\n${error.message}`,
        timedOut,
      });
    });
  });

const runGitStatus = () =>
  new Promise((resolve, reject) => {
    const child = spawn('git', ['status', '--short', '--untracked-files=all'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`git status failed:\n${stderr}`));
      }
    });
    child.on('error', reject);
  });

const main = async () => {
  const beforeStatus = await runGitStatus();
  const tempDir = outputDirEnv
    ? path.resolve(outputDirEnv)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'tenet-docs-review-e2e-'));
  const relativeOutputDir = path.relative(repoRoot, tempDir);
  const outputDirInsideRepo =
    relativeOutputDir === '' || (!relativeOutputDir.startsWith('..') && !path.isAbsolute(relativeOutputDir));
  if (outputDirEnv && outputDirInsideRepo) {
    throw new Error('DOCS_REVIEW_E2E_OUTPUT_DIR must be outside the repository so the E2E status guard can verify no repo files changed.');
  }
  fs.mkdirSync(tempDir, { recursive: true });
  const jsonOut = path.join(tempDir, 'report.json');
  const markdownOut = path.join(tempDir, 'report.md');
  const timeoutMs = (Number.parseInt(timeoutMinutes, 10) || 30) * 60 * 1000;

  const result = await run({
    command: process.execPath,
    args: [
      docsReviewPath,
      '--agents',
      agents,
      '--synthesizer',
      synthesizer,
      '--json-out',
      jsonOut,
      '--markdown-out',
      markdownOut,
      '--no-print',
      '--fail-on',
      'never',
      '--timeout-minutes',
      timeoutMinutes,
      '--repo-root',
      repoRoot,
    ],
    cwd: repoRoot,
    timeoutMs: timeoutMs + 30_000,
  });

  if (result.timedOut || result.code !== 0) {
    throw new Error(`docs-review e2e failed with code ${result.code}${result.timedOut ? ' (timed out)' : ''}\n\nSTDOUT:\n${result.stdout}\n\nSTDERR:\n${result.stderr}`);
  }

  const report = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
  const markdown = fs.readFileSync(markdownOut, 'utf8');

  if (report.version !== '1.0') {
    throw new Error('report.version must be 1.0');
  }
  if (!Array.isArray(report.decisions) || report.decisions.length === 0) {
    throw new Error('report.decisions must be a non-empty array');
  }
  if (!report.metadata || !Array.isArray(report.metadata.reviewers)) {
    throw new Error('report.metadata.reviewers is required');
  }
  if (!Array.isArray(report.metadata.merged_issues)) {
    throw new Error('report.metadata.merged_issues is required');
  }
  if (!Array.isArray(report.metadata.raw_findings)) {
    throw new Error('report.metadata.raw_findings is required');
  }
  if (!report.metadata.synthesis || report.metadata.synthesis.synthesizer !== synthesizer) {
    throw new Error(`report.metadata.synthesis.synthesizer must be ${synthesizer}`);
  }
  if (Array.isArray(report.metadata.tool_errors) && report.metadata.tool_errors.length > 0) {
    throw new Error(`reviewer tool errors were reported:\n${JSON.stringify(report.metadata.tool_errors, null, 2)}`);
  }

  const expectedAgents = agents.split(',').map((agent) => agent.trim()).filter(Boolean);
  const reviewerNames = report.metadata.reviewers.map((reviewer) => reviewer.reviewer);
  for (const agent of expectedAgents) {
    if (!reviewerNames.includes(agent)) {
      throw new Error(`missing reviewer metadata for ${agent}`);
    }
  }

  if (markdown.trim().length < 100) {
    throw new Error('Markdown report is unexpectedly short');
  }

  const afterStatus = await runGitStatus();
  if (afterStatus !== beforeStatus) {
    throw new Error(`docs-review e2e changed repo status\n\nBefore:\n${beforeStatus}\n\nAfter:\n${afterStatus}`);
  }

  if (shouldPrintMarkdown) {
    process.stdout.write(`\n${markdown}\n`);
  }

  process.stdout.write(`docs-review e2e passed\nagents: ${agents}\nsynthesizer: ${synthesizer}\njson: ${jsonOut}\nmarkdown: ${markdownOut}\n`);
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
