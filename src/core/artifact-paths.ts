import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const artifactPathsSchema = z
  .object({
    spec: z.string().min(1).optional(),
    harness: z.string().min(1).optional(),
    scenarios: z.string().min(1).nullable().optional(),
    interview: z.string().min(1).nullable().optional(),
    decomposition: z.string().min(1).nullable().optional(),
  })
  .strict();

export type ArtifactPathsInput = z.infer<typeof artifactPathsSchema>;

export type ArtifactPathKey = keyof ArtifactPathsInput;

export type ArtifactPaths = {
  spec?: string;
  harness?: string;
  scenarios?: string | null;
  interview?: string | null;
  decomposition?: string | null;
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const datedFeatureDocPattern = (feature: string): RegExp =>
  new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${escapeRegExp(feature)}\\.md$`);

const datedScenariosDocPattern = (feature: string): RegExp =>
  new RegExp(`^scenarios-\\d{4}-\\d{2}-\\d{2}-${escapeRegExp(feature)}\\.md$`);

export const toProjectRelativePath = (projectPath: string, rawPath: string, label: string): string => {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    throw new Error(`${label} path must not be empty`);
  }

  const resolved = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(projectPath, trimmed);
  const relative = path.relative(projectPath, resolved);

  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} path must be inside the project`);
  }

  return relative.split(path.sep).join(path.posix.sep);
};

const verifyArtifactFile = (projectPath: string, relativePath: string, label: string): void => {
  const fullPath = path.join(projectPath, relativePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`${label} not found at ${relativePath}`);
  }

  if (!fs.statSync(fullPath).isFile()) {
    throw new Error(`${label} must be a file: ${relativePath}`);
  }
};

export const normalizeArtifactPaths = (
  projectPath: string,
  rawPaths: ArtifactPathsInput,
  required: readonly ArtifactPathKey[],
  explicit: readonly ArtifactPathKey[] = [],
): ArtifactPaths => {
  const normalized: ArtifactPaths = {};

  for (const key of required) {
    const raw = rawPaths[key];
    if (raw == null) {
      throw new Error(`artifact_paths.${key} is required`);
    }
  }

  for (const key of explicit) {
    if (!(key in rawPaths)) {
      throw new Error(`artifact_paths.${key} must be provided as a path or null`);
    }
  }

  for (const [key, raw] of Object.entries(rawPaths) as Array<[ArtifactPathKey, string | null | undefined]>) {
    if (raw === undefined) {
      continue;
    }

    if (raw === null) {
      (normalized as Record<ArtifactPathKey, string | null | undefined>)[key] = null;
      continue;
    }

    const label = `artifact_paths.${key}`;
    const relative = toProjectRelativePath(projectPath, raw, label);
    verifyArtifactFile(projectPath, relative, label);
    (normalized as Record<ArtifactPathKey, string | null | undefined>)[key] = relative;
  }

  return normalized;
};

const resolveLatestByPattern = (dir: string, pattern: RegExp): string | undefined => {
  if (!fs.existsSync(dir)) {
    return undefined;
  }

  const matches = fs
    .readdirSync(dir)
    .filter((f) => pattern.test(f))
    .sort();

  if (matches.length === 0) {
    return undefined;
  }

  return path.join(dir, matches[matches.length - 1]);
};

export const resolveLatestFeatureDoc = (dir: string, feature: string): string | undefined =>
  resolveLatestByPattern(dir, datedFeatureDocPattern(feature));

export const resolveLatestScenariosDoc = (dir: string, feature: string): string | undefined =>
  resolveLatestByPattern(dir, datedScenariosDocPattern(feature));

export const readArtifactFile = (projectPath: string, relativePath: string, label: string): string => {
  verifyArtifactFile(projectPath, relativePath, label);
  return fs.readFileSync(path.join(projectPath, relativePath), 'utf8');
};
