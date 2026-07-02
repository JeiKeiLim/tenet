import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { JobManager } from '../../core/job-manager.js';
import { StateStore } from '../../core/state-store.js';
import {
  artifactPathsSchema,
  normalizeArtifactPaths,
  readArtifactFile,
  resolveLatestFeatureDoc,
  resolveLatestScenariosDoc,
  toProjectRelativePath,
  type ArtifactPaths,
} from '../../core/artifact-paths.js';
import { jsonResult, type RegisterTool } from './utils.js';

const READINESS_RUBRIC = `Score this feature's IMPLEMENTATION READINESS. You are reading the spec + harness (+ optional interview) and deciding whether the agent has enough information to BUILD AND VERIFY the feature.

This is NOT a clarity check on user requirements — that already happened upstream. You are checking whether the *implementation prerequisites* are known. Missing prerequisites here cause late-stage failures at execution or eval time.

## Hard gates before scoring

- If the optional interview declares "Mode: Full", the spec's front-matter "delivery_mode" must match the interview's "## Delivery Mode Decision".
- A Full-mode interview without "## Delivery Mode Decision", "Prompt shown", "User response", a valid "Selected delivery_mode", or a valid "Selection basis" is blocked.
- A bundled defaults question, unrelated "okay", or pre-execution confirmation does not satisfy Full-mode delivery-mode selection.
- If the spec declares "delivery_mode: agile", it must include "## Slice plan".
- If any hard gate fails, set "spec_sufficiency" to "blocked", set "passed" to false, and list the issue in "blockers".

## Scope — score each of the 8 categories independently

For each category, assign one of: "ready", "partial", "blocked".
- "ready": no information gaps that would prevent build/verification.
- "partial": some gaps, but work can start; note them in missing_info.
- "blocked": a gap that MUST be resolved before decomposition (credentials, key decisions, API contracts, etc.).

### 1. Spec sufficiency
- Are the acceptance criteria concrete enough to write tests against?
- Are error-handling policies, rate-limit behavior, and edge cases specified?
- Ambiguities that survived the clarity gate but only matter at build time (e.g., "what happens on 429?", "what's the retry policy?").
- Are factual claims about the existing codebase (file paths, current behavior, existing modules/APIs) grounded in real files cited in the spec, not assumed or invented? An un-cited or fabricated codebase claim is a blocker — the spec must reflect the actual project (greenfield runs have no existing code to cite; this applies only to claims about code that should already exist).

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
- E2E surface is declared: browser UI, visual/canvas/game, CLI, API, library, or not applicable.
- Browser/visual Playwright Layer 2 is declared as required, optional, or skipped with reason.
- For async/background/third-party surfaces that Playwright cannot see: is there a non-UI verification method (logs, metrics, DB assertions, event-store queries, explicit test hooks)?
- "How will we know this worked?" must have an answer for every success criterion.

### 8. Dependencies & tooling
- Required libs/runtimes confirmed installable in target env.
- Build/test commands runnable.
- Version pins where needed.

## Eval Execution Mode (separate judgment, not a scored category)

Answer this independent question about the feature's test surface:

> Do this feature's tests share mutable state (DB rows, sessions, rate limits, ports, files, long-lived processes, Playwright lock dirs)?

If YES — parallel critics will collide on that state and produce false failures that look like product bugs. Mark "eval_parallel_safe" as false and explain in "eval_parallel_rationale" which specific resource(s) are shared.

If NO — the feature is a pure library, CLI, data transformation, or otherwise stateless between runs. Mark "eval_parallel_safe" as true.

When in doubt, prefer false — the cost of sequential is a few extra minutes; the cost of parallel collision is a full cycle of false failures.

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
  "eval_parallel_safe": <boolean>,
  "eval_parallel_rationale": "<1-2 sentence explanation of why parallel critics are or are not safe for this feature>",
  "rationale": "<1-3 sentence summary of why the gate passed or failed and what the agent must do next>"
}

Where blockers are hard stops (must be resolved or explicitly mocked-with-reason) and missing_info are softer gaps that should be noted but do not block decomposition.`;

const readIfExists = (filePath: string): string | undefined => {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  return fs.readFileSync(filePath, 'utf8');
};

type DeliveryMode = 'autonomous' | 'agile';

const SLICE_PLAN_RE = /^## Slice plan\b/im;
const FULL_MODE_RE = /^Mode:\s*Full\b/im;
const DELIVERY_MODE_DECISION_RE = /^## Delivery Mode Decision\b/im;
const PROMPT_SHOWN_RE = /^\s*-\s*Prompt shown:\s*\S/im;
const USER_RESPONSE_RE = /^\s*-\s*User response:\s*\S/im;
const SELECTED_DELIVERY_MODE_RE = /^\s*-\s*Selected delivery_mode:\s*(autonomous|agile)\b/im;
const SELECTION_BASIS_RE =
  /^\s*-\s*Selection basis:\s*(explicit_user_choice|defaulted_after_explicit_choice_prompt|yolo_agent_decision)\b/im;

// Deterministic spec-substance gate. Catches unambiguous placeholder specs (TODO /
// FIXME / "placeholder" / lorem ipsum / ???) before dispatching the readiness model —
// a spec that carries unresolved placeholders into decomposition is not ready to plan
// against. Only PROSE is scanned: YAML front matter and fenced code blocks are stripped
// first, so a `// TODO` stub the worker will legitimately replace inside a code sample
// is not a false positive.
const SPEC_PLACEHOLDER_PATTERNS: ReadonlyArray<RegExp> = [
  /\bTODO\b/i,
  /\bTBD\b/i,
  /\bFIXME\b/i,
  /\blorem ipsum\b/i,
  /\bplaceholder\b/i,
  /\bto be determined\b/i,
  /\bto be decided\b/i,
  /\?\?\?+/,
];

const stripSpecNonProse = (specMd: string): string =>
  specMd
    .replace(/^---\s*\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '');

const getSpecSubstanceFailures = (specMd: string): string[] => {
  const prose = stripSpecNonProse(specMd);
  return SPEC_PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(prose))
    ? [
        'Spec contains unresolved placeholder markers (TODO/TBD/FIXME/placeholder/lorem ipsum/???). A spec carried into decomposition must be concrete — resolve or remove them, then re-run readiness.',
      ]
    : [];
};

type FrontMatterResult = {
  data: Record<string, unknown> | null;
  error?: string;
};

const FRONT_MATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

const parseFrontMatter = (markdown: string): FrontMatterResult => {
  const match = markdown.match(FRONT_MATTER_RE);
  if (!match) {
    return { data: null };
  }

  try {
    const parsed = parseYaml(match[1]) as unknown;
    if (parsed == null) {
      return { data: {} };
    }

    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { data: null, error: 'Spec front matter must be a YAML object.' };
    }

    return { data: parsed as Record<string, unknown> };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { data: null, error: `Spec front matter is invalid YAML: ${message}` };
  }
};

const parseSpecDeliveryMode = (specMd: string): { mode: DeliveryMode | null; error?: string } => {
  const frontMatter = parseFrontMatter(specMd);
  if (frontMatter.error) {
    return { mode: null, error: frontMatter.error };
  }

  const raw = frontMatter.data?.delivery_mode;
  if (typeof raw !== 'string') {
    return { mode: null };
  }

  const normalized = raw.toLowerCase();
  return normalized === 'autonomous' || normalized === 'agile'
    ? { mode: normalized }
    : { mode: null };
};

const parseInterviewDeliveryMode = (interviewMd: string): DeliveryMode | null => {
  const match = interviewMd.match(SELECTED_DELIVERY_MODE_RE);
  return match ? (match[1].toLowerCase() as DeliveryMode) : null;
};

const getReadinessPreflightFailures = (specMd: string, interviewMd?: string): string[] => {
  const failures: string[] = [];
  const specDeliveryMode = parseSpecDeliveryMode(specMd);
  const specMode = specDeliveryMode.mode;

  if (specDeliveryMode.error) {
    failures.push(specDeliveryMode.error);
  }

  failures.push(...getSpecSubstanceFailures(specMd));

  if (specMode === 'agile' && !SLICE_PLAN_RE.test(specMd)) {
    failures.push('Spec declares delivery_mode: agile but is missing ## Slice plan.');
  }

  if (!interviewMd || !FULL_MODE_RE.test(interviewMd)) {
    return failures;
  }

  if (!DELIVERY_MODE_DECISION_RE.test(interviewMd)) {
    failures.push('Full-mode interview is missing ## Delivery Mode Decision.');
    return failures;
  }

  if (!PROMPT_SHOWN_RE.test(interviewMd)) {
    failures.push('Full-mode interview has ## Delivery Mode Decision but no Prompt shown.');
  }

  if (!USER_RESPONSE_RE.test(interviewMd)) {
    failures.push('Full-mode interview has ## Delivery Mode Decision but no User response.');
  }

  const interviewMode = parseInterviewDeliveryMode(interviewMd);
  if (!interviewMode) {
    failures.push('Full-mode interview has ## Delivery Mode Decision but no valid Selected delivery_mode.');
  }

  if (!SELECTION_BASIS_RE.test(interviewMd)) {
    failures.push('Full-mode interview has ## Delivery Mode Decision but no valid Selection basis.');
  }

  if (!specMode) {
    failures.push('Full-mode spec is missing delivery_mode front matter.');
  } else if (interviewMode && specMode !== interviewMode) {
    failures.push(
      `Spec delivery_mode (${specMode}) does not match interview Delivery Mode Decision (${interviewMode}).`,
    );
  }

  return failures;
};

type ResolvedReadinessArtifacts = {
  artifactPaths: ArtifactPaths;
  specMd: string;
  harnessMd: string;
  interviewMd?: string;
  scenariosMd?: string;
  warning?: string;
};

const resolveReadinessArtifacts = (
  projectPath: string,
  feature: string,
  rawArtifactPaths?: z.infer<typeof artifactPathsSchema>,
): ResolvedReadinessArtifacts => {
  const tenetPath = path.join(projectPath, '.tenet');

  if (rawArtifactPaths) {
    const artifactPaths = normalizeArtifactPaths(
      projectPath,
      rawArtifactPaths,
      ['spec', 'harness'],
      ['scenarios', 'interview'],
    );
    const specMd = readArtifactFile(projectPath, artifactPaths.spec!, 'artifact_paths.spec');
    const harnessMd = readArtifactFile(projectPath, artifactPaths.harness!, 'artifact_paths.harness');
    const interviewMd = artifactPaths.interview
      ? readArtifactFile(projectPath, artifactPaths.interview, 'artifact_paths.interview')
      : undefined;
    const scenariosMd = artifactPaths.scenarios
      ? readArtifactFile(projectPath, artifactPaths.scenarios, 'artifact_paths.scenarios')
      : undefined;

    return { artifactPaths, specMd, harnessMd, interviewMd, scenariosMd };
  }

  const specPath = resolveLatestFeatureDoc(path.join(tenetPath, 'spec'), feature);
  if (!specPath) {
    throw new Error(
      `Spec not found for feature "${feature}" via legacy fallback — pass exact artifact_paths.spec for the current run (for new runs, .tenet/runs/<run-slug>/spec.md).`,
    );
  }

  const harnessPath = path.join(tenetPath, 'harness', 'current.md');
  const harnessMd = readIfExists(harnessPath);
  if (!harnessMd) {
    throw new Error(
      'Harness not found via legacy fallback at .tenet/harness/current.md — pass exact artifact_paths.harness for the current run (for new runs, .tenet/runs/<run-slug>/harness.md).',
    );
  }

  const interviewPath = resolveLatestFeatureDoc(path.join(tenetPath, 'interview'), feature);
  const scenariosPath = resolveLatestScenariosDoc(path.join(tenetPath, 'spec'), feature);

  return {
    artifactPaths: {
      spec: toProjectRelativePath(projectPath, specPath, 'resolved spec'),
      harness: toProjectRelativePath(projectPath, harnessPath, 'resolved harness'),
      interview: interviewPath
        ? toProjectRelativePath(projectPath, interviewPath, 'resolved interview')
        : null,
      scenarios: scenariosPath
        ? toProjectRelativePath(projectPath, scenariosPath, 'resolved scenarios')
        : null,
    },
    specMd: fs.readFileSync(specPath, 'utf8'),
    harnessMd,
    interviewMd: interviewPath ? fs.readFileSync(interviewPath, 'utf8') : undefined,
    scenariosMd: scenariosPath ? fs.readFileSync(scenariosPath, 'utf8') : undefined,
    warning:
      'artifact_paths was not provided; used strict legacy feature filename fallback. Pass exact run-local artifact_paths to avoid stale document selection.',
  };
};

const createReadinessFailureOutput = (failures: string[]) => ({
  passed: false,
  categories: {
    spec_sufficiency: 'blocked',
    research_prior_art: 'ready',
    interface_contracts: 'ready',
    external_service_access: 'not_applicable',
    env_runtime: 'ready',
    test_data_fixtures: 'not_applicable',
    test_strategy: 'ready',
    deps_tooling: 'ready',
  },
  blockers: failures,
  missing_info: [],
  testable_surfaces: {
    unit: 'blocked',
    integration: 'blocked',
    e2e: 'blocked',
  },
  eval_parallel_safe: false,
  eval_parallel_rationale:
    'Readiness did not proceed because a hard planning gate failed; default to sequential eval after remediation.',
  rationale: `Resolve the hard gate before decomposition: ${failures.join(' ')}`,
});

const createCompletedReadinessFailureJob = (
  jobManager: JobManager,
  stateStore: StateStore,
  feature: string,
  failures: string[],
  artifactPaths?: ArtifactPaths,
) => {
  const now = Date.now();
  const job = jobManager.createPendingJob('eval', {
    name: `readiness-delivery-mode-gate-${feature}`,
    prompt: `Deterministic readiness gate failure:\n${failures.map((failure) => `- ${failure}`).join('\n')}`,
    eval_type: 'readiness_validation',
    feature,
    ...(artifactPaths ? { artifact_paths: artifactPaths } : {}),
  });

  stateStore.setJobOutput(job.id, createReadinessFailureOutput(failures));
  stateStore.updateJob(job.id, {
    status: 'completed',
    startedAt: now,
    completedAt: now,
    lastHeartbeat: now,
  });
  stateStore.appendEvent(job.id, 'job_completed', { deterministic: true });

  return job;
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
        artifact_paths: artifactPathsSchema
          .optional()
          .describe(
            'Exact project-relative or absolute paths for current-run artifacts. ' +
              'Recommended: { spec, harness, scenarios, interview }. If omitted, Tenet uses a strict compatibility filename fallback and returns a warning.',
          ),
      }),
    },
    async ({ feature, artifact_paths }) => {
      const { artifactPaths, specMd, harnessMd, interviewMd, scenariosMd, warning } =
        resolveReadinessArtifacts(stateStore.projectPath, feature, artifact_paths);

      const preflightFailures = getReadinessPreflightFailures(specMd, interviewMd);
      if (preflightFailures.length > 0) {
        const job = createCompletedReadinessFailureJob(
          jobManager,
          stateStore,
          feature,
          preflightFailures,
          artifactPaths,
        );

        return jsonResult({
          job_id: job.id,
          message:
            'Readiness validation failed before dispatch. Use tenet_job_result to read the gate failure.',
          artifact_paths: artifactPaths,
          ...(warning ? { warning } : {}),
        });
      }

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
        artifact_paths: artifactPaths,
      });

      return jsonResult({
        job_id: job.id,
        message:
          'Readiness validation dispatched. Use tenet_job_wait + tenet_job_result to get the verdict.',
        artifact_paths: artifactPaths,
        ...(warning ? { warning } : {}),
      });
    },
  );
};
