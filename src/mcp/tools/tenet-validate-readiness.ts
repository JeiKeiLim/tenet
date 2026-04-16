import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { JobManager } from '../../core/job-manager.js';
import { StateStore } from '../../core/state-store.js';
import { jsonResult, type RegisterTool } from './utils.js';

const READINESS_RUBRIC = `Score this feature's IMPLEMENTATION READINESS. You are reading the spec + harness (+ optional interview) and deciding whether the agent has enough information to BUILD AND VERIFY the feature.

This is NOT a clarity check on user requirements — that already happened upstream. You are checking whether the *implementation prerequisites* are known. Missing prerequisites here cause late-stage failures at execution or eval time.

## Scope — score each of the 8 categories independently

For each category, assign one of: "ready", "partial", "blocked".
- "ready": no information gaps that would prevent build/verification.
- "partial": some gaps, but work can start; note them in missing_info.
- "blocked": a gap that MUST be resolved before decomposition (credentials, key decisions, API contracts, etc.).

### 1. Spec sufficiency
- Are the acceptance criteria concrete enough to write tests against?
- Are error-handling policies, rate-limit behavior, and edge cases specified?
- Ambiguities that survived the clarity gate but only matter at build time (e.g., "what happens on 429?", "what's the retry policy?").

### 2. Research & prior art
- If the approach uses a specific library, algorithm, or protocol — has it been decided and investigated?
- Are known gotchas / compatibility notes captured in the spec or referenced knowledge?
- Has the agent done enough reading to use third-party APIs correctly?

### 3. Interface contracts
- Internal: API shapes, event schemas, DB tables — pinned or still drifting?
- External: third-party API contracts (endpoints, auth flow, rate limits, error codes) understood before calling?

### 4. External service access
- Credentials for services the agent CALLS BUT DOES NOT BUILD: LLM API keys, payment sandbox keys (e.g. Stripe test mode), webhook signing secrets, vendor sandbox accounts.
- IMPORTANT: this category is NOT about services the feature itself implements. If the feature IS an OAuth provider, OAuth credentials are not a blocker — they are the work.
- Each external service call should have a named source of truth (env var, secret manager, user-provided).

### 5. Environment & runtime
- App start command, required env vars, local services/containers, ports.
- Health-check / smoke path.
- Anything needed to boot the app for e2e testing.

### 6. Test data & fixtures
- Seed users/records the agent can't synthesize (production-shaped data, real PDFs, real audio samples).
- Sandbox accounts on external services.
- Fixtures that require specific setup commands.

### 7. Test strategy (incl. non-UI verification)
- Per layer (unit / integration / e2e): declared as live, sandboxed, mocked, or skipped — WITH reason.
- For async/background/third-party surfaces that Playwright cannot see: is there a non-UI verification method (logs, metrics, DB assertions, event-store queries, explicit test hooks)?
- "How will we know this worked?" must have an answer for every success criterion.

### 8. Dependencies & tooling
- Required libs/runtimes confirmed installable in target env.
- Build/test commands runnable.
- Version pins where needed.

## Rules

- Be specific. Do not invent requirements the spec does not imply. If the spec says "no external calls," do not demand an LLM key.
- Infer feature scope from spec/harness: a backend-only feature can skip e2e (testable_surfaces.e2e = "not_applicable"); a UI-only feature with no external calls can skip external_service_access.
- If the spec explicitly declares a test layer as MOCKED with a stated reason, accept that — but flag in rationale if EVERY test layer is mocked (silent-passing risk).
- "passed" is true only if NO category is "blocked" for the feature's declared scope.

## Output Format
Respond with ONLY this JSON (no markdown, no explanation):

{
  "passed": <boolean>,
  "categories": {
    "spec_sufficiency": "ready|partial|blocked",
    "research_prior_art": "ready|partial|blocked",
    "interface_contracts": "ready|partial|blocked",
    "external_service_access": "ready|partial|blocked|not_applicable",
    "env_runtime": "ready|partial|blocked",
    "test_data_fixtures": "ready|partial|blocked|not_applicable",
    "test_strategy": "ready|partial|blocked",
    "deps_tooling": "ready|partial|blocked"
  },
  "blockers": ["<concrete blocker 1>", "<concrete blocker 2>"],
  "missing_info": ["<softer gap 1>", "<softer gap 2>"],
  "testable_surfaces": {
    "unit": "ready|ready_with_mocks|blocked|not_applicable",
    "integration": "ready|ready_with_mocks|blocked|not_applicable",
    "e2e": "ready|ready_with_mocks|blocked|not_applicable"
  },
  "rationale": "<1-3 sentence summary of why the gate passed or failed and what the agent must do next>"
}

Where blockers are hard stops (must be resolved or explicitly mocked-with-reason) and missing_info are softer gaps that should be noted but do not block decomposition.`;

const resolveLatest = (dir: string, feature: string): string | undefined => {
  if (!fs.existsSync(dir)) {
    return undefined;
  }

  const suffix = `-${feature}.md`;
  const matches = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(suffix))
    .sort();

  if (matches.length === 0) {
    return undefined;
  }

  return path.join(dir, matches[matches.length - 1]);
};

const readIfExists = (filePath: string): string | undefined => {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  return fs.readFileSync(filePath, 'utf8');
};

export const registerTenetValidateReadinessTool = (
  registerTool: RegisterTool,
  jobManager: JobManager,
  stateStore: StateStore,
): void => {
  registerTool(
    'tenet_validate_readiness',
    {
      description:
        'Dispatch a fresh agent to independently score IMPLEMENTATION READINESS for a feature. ' +
        'Call this AFTER spec + harness are written, BEFORE decomposition. Hard gate — decomposition ' +
        'should not proceed until this passes. Reads spec + harness (+ optional interview) and returns ' +
        'pass/fail, blockers, and per-layer testable surfaces. Agent resolves blockers by editing ' +
        'spec/harness, asking the user, or explicitly mocking with reason.',
      inputSchema: z.object({
        feature: z
          .string()
          .describe('Feature slug used to resolve spec/interview files (e.g. "oauth"). Required.'),
      }),
    },
    async ({ feature }) => {
      const tenetPath = path.join(stateStore.projectPath, '.tenet');

      const specPath = resolveLatest(path.join(tenetPath, 'spec'), feature);
      if (!specPath) {
        throw new Error(
          `Spec not found for feature "${feature}" — write .tenet/spec/{date}-${feature}.md before validating readiness`,
        );
      }
      const specMd = fs.readFileSync(specPath, 'utf8');

      const harnessMd = readIfExists(path.join(tenetPath, 'harness', 'current.md'));
      if (!harnessMd) {
        throw new Error(
          'Harness not found at .tenet/harness/current.md — update the harness before validating readiness',
        );
      }

      const interviewPath = resolveLatest(path.join(tenetPath, 'interview'), feature);
      const interviewMd = interviewPath ? fs.readFileSync(interviewPath, 'utf8') : undefined;

      const scenariosPath = resolveLatest(path.join(tenetPath, 'spec'), `scenarios-${feature}`);
      const scenariosMd = scenariosPath ? fs.readFileSync(scenariosPath, 'utf8') : undefined;

      const sections = [
        READINESS_RUBRIC,
        '---',
        `# Feature: ${feature}`,
        '',
        '## Spec',
        specMd,
        '',
        '## Harness',
        harnessMd,
      ];

      if (scenariosMd) {
        sections.push('', '## Scenarios & Anti-Scenarios', scenariosMd);
      }

      if (interviewMd) {
        sections.push('', '## Interview (reference only — do not re-score clarity)', interviewMd);
      }

      const prompt = sections.join('\n');

      const job = jobManager.startJob('eval', {
        prompt,
        eval_type: 'readiness_validation',
        feature,
      });

      return jsonResult({
        job_id: job.id,
        message:
          'Readiness validation dispatched. Use tenet_job_wait + tenet_job_result to get the verdict.',
      });
    },
  );
};
