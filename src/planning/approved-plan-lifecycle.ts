import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  comparePlanningArtifactPaths,
  describeTimestampedMissingBaselineIssues,
  parsePlanningArtifactFileName,
  planningArtifactSlug,
  selectLatestPlanningArtifactPath,
  selectMatchingTestSpecsForPrd,
} from './artifact-names.js';
import {
  advanceMarkdownFenceState,
  getMarkdownScanState,
  isIndentedMarkdownCodeLine,
  type MarkdownFenceState,
} from './markdown-structure.js';
import { normalizePlanningRepoRelativePath, resolveDeclaredContextPackPath } from './path-utils.js';
import {
  computeContextPackObjectSha1,
  contextPackIndexPath,
  findMissingContextPackRoles,
  inspectContextPackBasis,
  inspectContextPackGeneratedIndex,
  parseContextPackPathInfo,
  readContextPackDocument,
  REQUIRED_CONTEXT_PACK_ROLES,
  validateContextPackManifest,
  type ContextPackBasis,
  type ContextPackBasisState,
  type ContextPackExecutionRef,
  type ContextPackRole,
} from './context-packs.js';
import { omxPlansDir, sameFilePath } from '../utils/paths.js';

const PRD_PATTERN = /^prd-.*\.md$/i;
const TEST_SPEC_PATTERN = /^test-?spec-.*\.md$/i;
const DEEP_INTERVIEW_SPEC_PATTERN = /^deep-interview-.*\.md$/i;
const CONTEXT_PACK_PATTERN = /^context-.*\.json$/i;
const CONTEXT_PACK_OUTCOME_HEADING_PATTERN = /^#{1,6}\s+Context Pack Outcome\s*$/i;
const CONTEXT_PACK_OUTCOME_DECLARATION_PREFIX_PATTERN = /^[*-]\s*pack\s*:/i;
const CONTEXT_PACK_OUTCOME_LINE_PATTERN = /^[*-]\s*pack\s*:\s*(?<action>created|refreshed|revalidated)\s+(?:`(?<quotedPath>[^`]+\.json)`|(?<barePath>\S+\.json))\s*$/i;

export type ContextPackAction = 'created' | 'refreshed' | 'revalidated';

export interface ContextPackRef {
  path: string;
  action: ContextPackAction;
}

export type ContextPackStatus = 'missing-baseline' | 'ready' | 'plan-only' | 'incomplete' | 'invalid';
export type ContextPackBaselineState = 'missing-prd' | 'missing-test-spec' | 'present';
export type ContextPackOutcomeState = 'absent' | 'malformed' | 'ambiguous' | 'single' | 'single-other';
export type ContextPackPackState = 'missing' | 'unreadable' | 'schema-invalid' | 'valid';
export type ContextPackRoleCoverageState = 'missing-required-roles' | 'covered';
export type ContextPackIndexState = 'missing' | 'invalid' | 'fresh';

export interface PlanningArtifacts {
  plansDir: string;
  specsDir: string;
  contextDir: string;
  prdPaths: string[];
  testSpecPaths: string[];
  deepInterviewSpecPaths: string[];
  contextPackPaths: string[];
}

export interface LatestPlanningArtifactSelection {
  prdPath: string | null;
  canonicalPrdPath: string | null;
  testSpecPaths: string[];
  deepInterviewSpecPaths: string[];
  contextPack: ContextPackRef | null;
  contextPackStatus: ContextPackStatus;
  missingRequiredContextPackRoles: ContextPackRole[];
  contextPackIssues: string[];
}

export interface ContextPackHandoffStatusSnapshot {
  packPath: string;
  indexPath: string;
  slug: string | null;
  prdPath: string | null;
  testSpecPaths: string[];
  declaredPackPath: string | null;
  baselineState: ContextPackBaselineState;
  outcomeState: ContextPackOutcomeState;
  packState: ContextPackPackState;
  roleCoverage: ContextPackRoleCoverageState;
  basisState: ContextPackBasisState;
  indexState: ContextPackIndexState;
  handoffState: ContextPackStatus;
  missingRequiredContextPackRoles: ContextPackRole[];
  issues: string[];
}

export interface ApprovedPlanBaselineResolution {
  slug: string | null;
  prdPath: string | null;
  canonicalPrdPath: string | null;
  baselineState: ContextPackBaselineState;
  testSpecPaths: string[];
  baselineIssues: string[];
  basis?: ContextPackBasis;
}

export interface ContextPackLifecycleResolution {
  contextPack: ContextPackRef | null;
  declaredPackPath: string | null;
  outcomeState: ContextPackOutcomeState;
  packState: ContextPackPackState;
  roleCoverage: ContextPackRoleCoverageState;
  basisState: ContextPackBasisState;
  indexState: ContextPackIndexState;
  missingRequiredContextPackRoles: ContextPackRole[];
  contextPackIssues: string[];
  contextPackStatus: ContextPackStatus;
}

interface PlanningArtifactPrdIdentity {
  canonicalPath: string;
  persistedPath: string;
}

interface ContextPackOutcomeInspection {
  outcomeState: ContextPackOutcomeState;
  contextPack: ContextPackRef | null;
  declaredPackPath: string | null;
  issues: string[];
}

interface ResolveApprovedPlanBaselineOptions {
  includeBasis?: boolean;
}

function uniqueIssues(...groups: ReadonlyArray<readonly string[]>): string[] {
  const issues: string[] = [];
  for (const group of groups) {
    for (const issue of group) {
      if (!issues.includes(issue)) {
        issues.push(issue);
      }
    }
  }
  return issues;
}

function cloneRequiredContextPackRoles(): ContextPackRole[] {
  return [...REQUIRED_CONTEXT_PACK_ROLES];
}

export function isApprovedExecutionFollowupReadyStatus(status: ContextPackStatus): boolean {
  return status === 'ready' || status === 'plan-only';
}

export function isApprovedExecutionContextReadyStatus(status: ContextPackStatus): boolean {
  return status === 'ready';
}

function readMatchingPaths(dir: string, pattern: RegExp): string[] {
  if (!existsSync(dir)) {
    return [];
  }

  try {
    return readdirSync(dir)
      .filter((file) => pattern.test(file))
      .sort((a, b) => a.localeCompare(b))
      .map((file) => join(dir, file));
  } catch {
    return [];
  }
}

export function readPlanningArtifacts(cwd: string): PlanningArtifacts {
  const plansDir = omxPlansDir(cwd);
  const specsDir = join(cwd, '.omx', 'specs');
  const contextDir = join(cwd, '.omx', 'context');

  return {
    plansDir,
    specsDir,
    contextDir,
    prdPaths: readMatchingPaths(plansDir, PRD_PATTERN),
    testSpecPaths: readMatchingPaths(plansDir, TEST_SPEC_PATTERN),
    deepInterviewSpecPaths: readMatchingPaths(specsDir, DEEP_INTERVIEW_SPEC_PATTERN)
      .filter((path) => parsePlanningArtifactFileName(path)?.kind === 'deep-interview')
      .sort(comparePlanningArtifactPaths),
    contextPackPaths: readMatchingPaths(contextDir, CONTEXT_PACK_PATTERN),
  };
}

function resolvePlanningArtifactPrdIdentity(
  artifacts: PlanningArtifacts,
  prdPath: string | null,
): PlanningArtifactPrdIdentity | null {
  if (!prdPath) {
    return null;
  }

  const repoRoot = dirname(dirname(artifacts.plansDir));
  if (isAbsolute(prdPath)) {
    const resolvedPath = resolve(prdPath);
    const matchedArtifact = artifacts.prdPaths.find((candidatePath) => sameFilePath(candidatePath, resolvedPath));
    return matchedArtifact
      ? { canonicalPath: matchedArtifact, persistedPath: resolvedPath }
      : null;
  }

  const normalizedPath = normalizePlanningRepoRelativePath(prdPath);
  const lexicalMatch = artifacts.prdPaths.find((candidatePath) => {
    const repoRelativePath = normalizePlanningRepoRelativePath(relative(repoRoot, candidatePath));
    const plansRelativePath = normalizePlanningRepoRelativePath(relative(artifacts.plansDir, candidatePath));
    return normalizedPath === repoRelativePath || normalizedPath === plansRelativePath;
  });
  if (lexicalMatch) {
    return {
      canonicalPath: lexicalMatch,
      persistedPath: lexicalMatch,
    };
  }

  const resolvedPath = resolve(repoRoot, prdPath);
  const matchedArtifact = artifacts.prdPaths.find((candidatePath) => sameFilePath(candidatePath, resolvedPath));
  return matchedArtifact
    ? {
      canonicalPath: matchedArtifact,
      persistedPath: resolvedPath,
    }
    : null;
}

function buildContextPackBasisFromPaths(
  repoRoot: string,
  canonicalPrdPath: string,
  testSpecPaths: readonly string[],
): ContextPackBasis {
  const prdRelativePath = normalizePlanningRepoRelativePath(relative(repoRoot, canonicalPrdPath));
  return {
    prd: {
      path: prdRelativePath,
      sha1: computeContextPackObjectSha1(canonicalPrdPath),
    },
    testSpecs: [...testSpecPaths]
      .sort(comparePlanningArtifactPaths)
      .map((path) => {
        const relativePath = normalizePlanningRepoRelativePath(relative(repoRoot, path));
        return {
          path: relativePath,
          sha1: computeContextPackObjectSha1(path),
        };
      }),
  };
}

export function resolveApprovedPlanBaseline(
  artifacts: PlanningArtifacts,
  prdPath: string | null,
  options: ResolveApprovedPlanBaselineOptions = {},
): ApprovedPlanBaselineResolution {
  const prdIdentity = resolvePlanningArtifactPrdIdentity(artifacts, prdPath);
  const resolvedPrdPath = prdIdentity?.persistedPath ?? null;
  const canonicalPrdPath = prdIdentity?.canonicalPath ?? null;
  const slug = canonicalPrdPath ? planningArtifactSlug(canonicalPrdPath, 'prd') : null;
  const testSpecSelection = selectMatchingTestSpecsForPrd(canonicalPrdPath, artifacts.testSpecPaths);
  const testSpecPaths = testSpecSelection.paths;
  const baselineState: ContextPackBaselineState = !canonicalPrdPath || !existsSync(canonicalPrdPath)
    ? 'missing-prd'
    : testSpecPaths.length === 0
      ? 'missing-test-spec'
      : 'present';
  const baselineIssues = baselineState === 'missing-test-spec' && resolvedPrdPath
    ? [
      'Approved plan is missing a matching test spec.',
      ...describeTimestampedMissingBaselineIssues(canonicalPrdPath, artifacts.testSpecPaths),
    ]
    : [];
  const shouldIncludeBasis = options.includeBasis === true;

  return {
    slug,
    prdPath: resolvedPrdPath,
    canonicalPrdPath,
    baselineState,
    testSpecPaths,
    baselineIssues,
    ...(shouldIncludeBasis && baselineState === 'present' && canonicalPrdPath
      ? {
        basis: buildContextPackBasisFromPaths(
          dirname(dirname(artifacts.plansDir)),
          canonicalPrdPath,
          testSpecPaths,
        ),
      }
      : {}),
  };
}

export function resolveApprovedPlanBaselineForSlug(
  repoRoot: string,
  slug: string,
  options: ResolveApprovedPlanBaselineOptions = {},
): ApprovedPlanBaselineResolution {
  const artifacts = readPlanningArtifacts(repoRoot);
  const prdPath = selectBaselinePrdPathForSlug(artifacts.prdPaths, slug);
  return resolveApprovedPlanBaseline(artifacts, prdPath, options);
}

function selectDeepInterviewSpecPathsForSlug(
  deepInterviewSpecPaths: readonly string[],
  slug: string | null,
): string[] {
  if (!slug) return [];
  return deepInterviewSpecPaths
    .filter((path) => planningArtifactSlug(path, 'deep-interview') === slug)
    .sort(comparePlanningArtifactPaths);
}

function classifyGeneratedIndexState(
  inspection: ReturnType<typeof inspectContextPackGeneratedIndex>,
): ContextPackIndexState {
  return inspection.status === 'ready' ? 'fresh' : inspection.status;
}

function resolveDeclaredContextPackLifecycle(
  repoRoot: string,
  slug: string,
  ref: ContextPackRef,
  declaredPackPath: string,
): ContextPackLifecycleResolution {
  if (!existsSync(ref.path)) {
    return {
      contextPack: ref,
      declaredPackPath,
      outcomeState: 'single',
      packState: 'missing',
      roleCoverage: 'missing-required-roles',
      basisState: 'absent',
      indexState: 'missing',
      missingRequiredContextPackRoles: cloneRequiredContextPackRoles(),
      contextPackIssues: [`Declared context pack file is missing: ${declaredPackPath}.`],
      contextPackStatus: 'incomplete',
    };
  }

  const validationIssues = inspectContextPackBasisAndManifest(repoRoot, ref.path, slug);
  const document = readContextPackDocument(ref.path);
  const missingRequiredContextPackRoles = document
    ? findMissingContextPackRoles(document, REQUIRED_CONTEXT_PACK_ROLES)
    : cloneRequiredContextPackRoles();
  const roleCoverage: ContextPackRoleCoverageState = missingRequiredContextPackRoles.length > 0
    ? 'missing-required-roles'
    : 'covered';
  if (validationIssues.length > 0) {
    return {
      contextPack: ref,
      declaredPackPath,
      outcomeState: 'single',
      packState: 'schema-invalid',
      roleCoverage,
      basisState: 'absent',
      indexState: 'missing',
      missingRequiredContextPackRoles,
      contextPackIssues: validationIssues,
      contextPackStatus: 'invalid',
    };
  }

  const generatedIndexInspection = inspectContextPackGeneratedIndex(ref.path, document as NonNullable<typeof document>);
  const missingCoverageIssues = missingRequiredContextPackRoles.length > 0
    ? [`Declared context pack is missing required roles: ${missingRequiredContextPackRoles.join(', ')}.`]
    : [];
  const contextPackIssues = uniqueIssues(missingCoverageIssues, generatedIndexInspection.issues);
  const packState: ContextPackPackState = 'valid';
  const basisState: ContextPackBasisState = 'fresh';
  const indexState = classifyGeneratedIndexState(generatedIndexInspection);
  const contextPackStatus = resolveContextPackHandoffState({
    baselineState: 'present',
    outcomeState: 'single',
    packState,
    roleCoverage,
    basisState,
    indexState,
  });

  return {
    contextPack: ref,
    declaredPackPath,
    outcomeState: 'single',
    packState,
    roleCoverage,
    basisState,
    indexState,
    missingRequiredContextPackRoles,
    contextPackIssues,
    contextPackStatus,
  };
}

function inspectContextPackBasisAndManifest(
  repoRoot: string,
  packPath: string,
  expectedSlug: string,
): string[] {
  return validateContextPackManifest({
    packPath,
    expectedSlug,
    repoRoot,
    requireFreshBasis: true,
  });
}

function extractContextPackOutcomeSections(content: string): string[][] {
  const lines = content.split(/\r?\n/);
  const sections: string[][] = [];
  let activeFence: MarkdownFenceState | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (getMarkdownScanState(activeFence, line) !== 'normal' || !CONTEXT_PACK_OUTCOME_HEADING_PATTERN.test(trimmed)) {
      activeFence = advanceMarkdownFenceState(activeFence, line);
      continue;
    }
    activeFence = advanceMarkdownFenceState(activeFence, line);

    const section: string[] = [];
    for (let sectionIndex = index + 1; sectionIndex < lines.length; sectionIndex += 1) {
      const sectionLine = lines[sectionIndex]!;
      const sectionTrimmed = sectionLine.trim();
      if (
        isIndentedMarkdownCodeLine(sectionLine)
        || /^#{1,6}\s+\S/.test(sectionTrimmed)
        || (sectionTrimmed !== '' && !/^[*-]\s+/.test(sectionTrimmed))
      ) {
        break;
      }
      section.push(sectionLine);
    }
    sections.push(section);
  }

  return sections;
}

function readContextPackOutcomeDeclaration(
  repoRoot: string,
  line: string,
): {
    isDeclaration: boolean;
    declaredPath: string | null;
    ref: ContextPackRef | null;
    issue: string | null;
  } {
  if (!CONTEXT_PACK_OUTCOME_DECLARATION_PREFIX_PATTERN.test(line)) {
    return {
      isDeclaration: false,
      declaredPath: null,
      ref: null,
      issue: null,
    };
  }

  const lineMatch = line.match(CONTEXT_PACK_OUTCOME_LINE_PATTERN);
  if (!lineMatch?.groups) {
    return {
      isDeclaration: true,
      declaredPath: null,
      ref: null,
      issue: `Invalid Context Pack Outcome line: ${line}`,
    };
  }

  const resolvedPath = resolveDeclaredContextPackPath(
    repoRoot,
    lineMatch.groups.quotedPath ?? lineMatch.groups.barePath,
  );
  if (!resolvedPath) {
    return {
      isDeclaration: true,
      declaredPath: null,
      ref: null,
      issue: 'Context Pack Outcome must point to .omx/context/context-<timestamp>-<slug>.json.',
    };
  }

  return {
    isDeclaration: true,
    declaredPath: resolvedPath.normalizedPath,
    ref: {
      path: resolvedPath.resolvedPath,
      action: lineMatch.groups.action.toLowerCase() as ContextPackAction,
    },
    issue: null,
  };
}

function inspectContextPackOutcome(repoRoot: string, content: string): ContextPackOutcomeInspection {
  const outcomeSections = extractContextPackOutcomeSections(content);
  let ref: ContextPackRef | null = null;
  let declaredPackPath: string | null = null;
  const issues: string[] = [];
  let hasDuplicatePackDeclaration = false;

  if (outcomeSections.length === 0) {
    return {
      outcomeState: 'absent',
      contextPack: null,
      declaredPackPath: null,
      issues: [],
    };
  }
  if (outcomeSections.length > 1) {
    return {
      outcomeState: 'ambiguous',
      contextPack: null,
      declaredPackPath: null,
      issues: ['Approved plan contains multiple Context Pack Outcome sections.'],
    };
  }

  for (const line of outcomeSections[0]!) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const declaration = readContextPackOutcomeDeclaration(repoRoot, trimmed);
    if (!declaration.isDeclaration) {
      continue;
    }
    if (declaration.issue) {
      issues.push(declaration.issue);
      continue;
    }
    if (ref) {
      issues.push('Context Pack Outcome may declare only one pack.');
      hasDuplicatePackDeclaration = true;
      continue;
    }
    declaredPackPath = declaration.declaredPath;
    ref = declaration.ref;
  }

  if (issues.length > 0) {
    return {
      outcomeState: hasDuplicatePackDeclaration ? 'ambiguous' : 'malformed',
      contextPack: ref,
      declaredPackPath,
      issues,
    };
  }

  if (!ref) {
    return {
      outcomeState: 'malformed',
      contextPack: null,
      declaredPackPath: null,
      issues: ['Context Pack Outcome must declare exactly one pack.'],
    };
  }

  return {
    outcomeState: 'single',
    contextPack: ref,
    declaredPackPath,
    issues: [],
  };
}

export function resolveContextPackHandoffState(input: {
  baselineState: ContextPackBaselineState;
  outcomeState: ContextPackOutcomeState;
  packState: ContextPackPackState;
  roleCoverage: ContextPackRoleCoverageState;
  basisState: ContextPackBasisState;
  indexState: ContextPackIndexState;
}): ContextPackStatus {
  if (input.baselineState !== 'present') {
    return 'missing-baseline';
  }
  if (input.outcomeState === 'absent') {
    return 'plan-only';
  }
  if (
    input.outcomeState === 'malformed'
    || input.outcomeState === 'ambiguous'
    || input.outcomeState === 'single-other'
  ) {
    return 'invalid';
  }
  if (input.packState === 'missing') {
    return 'incomplete';
  }
  if (input.packState === 'unreadable' || input.packState === 'schema-invalid') {
    return 'invalid';
  }
  if (input.basisState !== 'fresh') {
    return 'invalid';
  }
  if (input.indexState === 'invalid') {
    return 'invalid';
  }
  if (input.roleCoverage === 'missing-required-roles') {
    return 'incomplete';
  }
  if (input.indexState === 'missing') {
    return 'incomplete';
  }
  return 'ready';
}

function resolveApprovedPlanContextPackLifecycle(
  artifacts: PlanningArtifacts,
  baseline: ApprovedPlanBaselineResolution,
): ContextPackLifecycleResolution {
  if (!baseline.canonicalPrdPath || !existsSync(baseline.canonicalPrdPath)) {
    return {
      contextPack: null,
      declaredPackPath: null,
      outcomeState: 'absent',
      packState: 'missing',
      roleCoverage: 'covered',
      basisState: 'absent',
      indexState: 'missing',
      missingRequiredContextPackRoles: [],
      contextPackIssues: [],
      contextPackStatus: 'plan-only',
    };
  }

  const repoRoot = dirname(dirname(artifacts.plansDir));

  try {
    const content = readFileSync(baseline.canonicalPrdPath, 'utf-8');
    const outcome = inspectContextPackOutcome(repoRoot, content);

    if (outcome.outcomeState === 'absent') {
      return {
        contextPack: null,
        declaredPackPath: null,
        outcomeState: 'absent',
        packState: 'missing',
        roleCoverage: 'covered',
        basisState: 'absent',
        indexState: 'missing',
        missingRequiredContextPackRoles: [],
        contextPackIssues: [],
        contextPackStatus: 'plan-only',
      };
    }
    if (outcome.outcomeState === 'ambiguous') {
      return {
        contextPack: null,
        declaredPackPath: null,
        outcomeState: 'ambiguous',
        packState: 'missing',
        roleCoverage: 'missing-required-roles',
        basisState: 'absent',
        indexState: 'missing',
        missingRequiredContextPackRoles: cloneRequiredContextPackRoles(),
        contextPackIssues: outcome.issues,
        contextPackStatus: 'invalid',
      };
    }
    if (outcome.outcomeState === 'malformed') {
      return {
        contextPack: outcome.contextPack,
        declaredPackPath: outcome.declaredPackPath,
        outcomeState: 'malformed',
        packState: 'missing',
        roleCoverage: outcome.contextPack ? 'missing-required-roles' : 'covered',
        basisState: 'absent',
        indexState: 'missing',
        missingRequiredContextPackRoles: outcome.contextPack ? cloneRequiredContextPackRoles() : [],
        contextPackIssues: outcome.issues,
        contextPackStatus: 'invalid',
      };
    }

    return resolveDeclaredContextPackLifecycle(
      repoRoot,
      baseline.slug as string,
      outcome.contextPack as ContextPackRef,
      outcome.declaredPackPath as string,
    );
  } catch {
    return {
      contextPack: null,
      declaredPackPath: null,
      outcomeState: 'malformed',
      packState: 'unreadable',
      roleCoverage: 'covered',
      basisState: 'absent',
      indexState: 'missing',
      missingRequiredContextPackRoles: [],
      contextPackIssues: ['Approved plan could not be read while resolving context packs.'],
      contextPackStatus: 'invalid',
    };
  }
}

export function selectPlanningArtifactsForPrdPath(
  artifacts: PlanningArtifacts,
  prdPath: string | null,
): LatestPlanningArtifactSelection {
  const baseline = resolveApprovedPlanBaseline(artifacts, prdPath);
  const deepInterviewSpecPaths = selectDeepInterviewSpecPathsForSlug(artifacts.deepInterviewSpecPaths, baseline.slug);
  const contextPackLifecycle = resolveApprovedPlanContextPackLifecycle(artifacts, baseline);
  const missingBaseline = baseline.baselineState !== 'present';

  return {
    prdPath: baseline.prdPath,
    canonicalPrdPath: baseline.canonicalPrdPath,
    testSpecPaths: baseline.testSpecPaths,
    deepInterviewSpecPaths,
    contextPack: contextPackLifecycle.contextPack,
    contextPackStatus: missingBaseline ? 'missing-baseline' : contextPackLifecycle.contextPackStatus,
    missingRequiredContextPackRoles: contextPackLifecycle.missingRequiredContextPackRoles,
    contextPackIssues: missingBaseline
      ? uniqueIssues(baseline.baselineIssues, contextPackLifecycle.contextPackIssues)
      : contextPackLifecycle.contextPackIssues,
  };
}

export function resolvePlanningArtifactSelection(
  artifacts: PlanningArtifacts,
  prdPath?: string | null,
): LatestPlanningArtifactSelection {
  return selectPlanningArtifactsForPrdPath(
    artifacts,
    prdPath ?? selectLatestPlanningArtifactPath(artifacts.prdPaths),
  );
}

// Slug-based basis, sync, and handoff lookups preserve the legacy exact basename
// preference instead of using the generic latest-artifact selector.
export function selectBaselinePrdPathForSlug(paths: readonly string[], slug: string): string | null {
  const matchingPrdPaths = paths.filter((path) => planningArtifactSlug(path, 'prd') === slug);
  const timestampedPrdPaths = matchingPrdPaths.filter((path) => parsePlanningArtifactFileName(path)?.timestamp);
  if (timestampedPrdPaths.length > 0) {
    return selectLatestPlanningArtifactPath(timestampedPrdPaths);
  }

  const exactLegacyPrdPath = matchingPrdPaths.find((path) => basename(path) === `prd-${slug}.md`) ?? null;
  return exactLegacyPrdPath ?? selectLatestPlanningArtifactPath(matchingPrdPaths);
}

function sameResolvedPath(left: string, right: string): boolean {
  try {
    return realpathSync.native(left) === realpathSync.native(right);
  } catch {
    return resolve(left) === resolve(right);
  }
}

function inspectContextPackDocumentLifecycle(
  packPath: string,
  repoRoot: string,
): {
    slug: string | null;
    packState: ContextPackPackState;
    roleCoverage: ContextPackRoleCoverageState;
    basisState: ContextPackBasisState;
    indexState: ContextPackIndexState;
    missingRequiredContextPackRoles: ContextPackRole[];
    contextPackIssues: string[];
  } {
  const documentExists = existsSync(packPath);
  const document = documentExists ? readContextPackDocument(packPath) : null;
  const issues: string[] = [];
  let slug: string | null = parseContextPackPathInfo(packPath)?.slugHint ?? null;
  let packState: ContextPackPackState = 'missing';
  let roleCoverage: ContextPackRoleCoverageState = 'missing-required-roles';
  let basisState: ContextPackBasisState = 'absent';
  let indexState: ContextPackIndexState = 'missing';
  let missingRequiredContextPackRoles: ContextPackRole[] = cloneRequiredContextPackRoles();

  if (!documentExists) {
    issues.push(`Context pack not found: ${packPath}`);
    return {
      slug,
      packState,
      roleCoverage,
      basisState,
      indexState,
      missingRequiredContextPackRoles,
      contextPackIssues: issues,
    };
  }

  try {
    readFileSync(packPath, 'utf-8');
    if (!document) {
      packState = 'schema-invalid';
      issues.push(`Could not read context pack: ${packPath}`);
      return {
        slug,
        packState,
        roleCoverage,
        basisState,
        indexState,
        missingRequiredContextPackRoles,
        contextPackIssues: issues,
      };
    }

    slug = document.slug;
    const manifestIssues = validateContextPackManifest({
      packPath,
      expectedSlug: slug,
      repoRoot,
    });
    if (manifestIssues.length > 0) {
      packState = 'schema-invalid';
      issues.push(...manifestIssues);
    } else {
      packState = 'valid';
    }

    missingRequiredContextPackRoles = findMissingContextPackRoles(document, REQUIRED_CONTEXT_PACK_ROLES);
    roleCoverage = missingRequiredContextPackRoles.length > 0 ? 'missing-required-roles' : 'covered';
    if (missingRequiredContextPackRoles.length > 0) {
      issues.push(`Declared context pack is missing required roles: ${missingRequiredContextPackRoles.join(', ')}.`);
    }

    const basisInspection = inspectContextPackBasis(document, packPath, repoRoot, slug);
    basisState = basisInspection.status;
    issues.push(...basisInspection.issues);

    const indexInspection = inspectContextPackGeneratedIndex(packPath, document);
    indexState = classifyGeneratedIndexState(indexInspection);
    issues.push(...indexInspection.issues);
  } catch {
    packState = 'unreadable';
    issues.push(`Context pack could not be read: ${packPath}`);
  }

  return {
    slug,
    packState,
    roleCoverage,
    basisState,
    indexState,
    missingRequiredContextPackRoles,
    contextPackIssues: issues,
  };
}

export function readContextPackHandoffStatus(
  repoRoot: string,
  packPath: string,
): ContextPackHandoffStatusSnapshot {
  const artifacts = readPlanningArtifacts(repoRoot);
  const indexPath = contextPackIndexPath(packPath);
  const packLifecycle = inspectContextPackDocumentLifecycle(packPath, repoRoot);
  const slug = packLifecycle.slug;
  const baseline = slug
    ? resolveApprovedPlanBaseline(artifacts, selectBaselinePrdPathForSlug(artifacts.prdPaths, slug))
    : {
      slug: null,
      prdPath: null,
      canonicalPrdPath: null,
      baselineState: 'missing-prd' as const,
      testSpecPaths: [],
      baselineIssues: [],
    };

  let outcomeState: ContextPackOutcomeState = 'absent';
  let declaredPackPath: string | null = null;
  const outcomeIssues: string[] = [];
  if (baseline.canonicalPrdPath && existsSync(baseline.canonicalPrdPath)) {
    try {
      const outcome = inspectContextPackOutcome(repoRoot, readFileSync(baseline.canonicalPrdPath, 'utf-8'));
      outcomeState = outcome.outcomeState;
      declaredPackPath = outcome.declaredPackPath;
      outcomeIssues.push(...outcome.issues);
      if (outcome.outcomeState === 'single' && outcome.contextPack && !sameResolvedPath(outcome.contextPack.path, packPath)) {
        outcomeState = 'single-other';
        outcomeIssues.push(`Context Pack Outcome declares ${declaredPackPath as string}, not ${packPath}.`);
      }
    } catch {
      outcomeState = 'malformed';
      outcomeIssues.push(`Approved PRD could not be read for slug ${slug}.`);
    }
  }

  const baselineIssues = baseline.baselineState === 'missing-prd'
    ? [slug ? `Approved PRD is missing for slug ${slug}.` : 'Could not infer a context-pack slug for approved PRD lookup.']
    : baseline.baselineState === 'missing-test-spec'
      ? [
        `Approved plan is missing a matching test spec for slug ${slug}.`,
        ...baseline.baselineIssues.slice(1),
      ]
      : [];
  const issues = uniqueIssues(
    baselineIssues,
    packLifecycle.contextPackIssues,
    outcomeIssues,
  );
  const handoffState = resolveContextPackHandoffState({
    baselineState: baseline.baselineState,
    outcomeState,
    packState: packLifecycle.packState,
    roleCoverage: packLifecycle.roleCoverage,
    basisState: packLifecycle.basisState,
    indexState: packLifecycle.indexState,
  });

  return {
    packPath,
    indexPath,
    slug,
    prdPath: baseline.prdPath,
    testSpecPaths: baseline.testSpecPaths,
    declaredPackPath,
    baselineState: baseline.baselineState,
    outcomeState,
    packState: packLifecycle.packState,
    roleCoverage: packLifecycle.roleCoverage,
    basisState: packLifecycle.basisState,
    indexState: packLifecycle.indexState,
    handoffState,
    missingRequiredContextPackRoles: packLifecycle.missingRequiredContextPackRoles,
    issues,
  };
}

export type { ContextPackExecutionRef };
