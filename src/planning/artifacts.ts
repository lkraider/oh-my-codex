import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  REQUIRED_CONTEXT_PACK_ROLES,
  materializeContextPackRefs,
  type ContextPackBasisState,
  type ContextPackExecutionRef,
  type ContextPackRole,
} from './context-packs.js';
import { collectMarkdownVisibleMatches } from './markdown-structure.js';
import {
  comparePlanningArtifactPaths,
  planningArtifactSlug,
  selectLatestPlanningArtifactPath,
} from './artifact-names.js';
import {
  isApprovedExecutionContextReadyStatus as isApprovedExecutionContextReadyStatusCore,
  isApprovedExecutionFollowupReadyStatus as isApprovedExecutionFollowupReadyStatusCore,
  readContextPackHandoffStatus as readContextPackHandoffStatusCore,
  readPlanningArtifacts as readPlanningArtifactsCore,
  resolveContextPackHandoffState as resolveContextPackHandoffStateCore,
  resolvePlanningArtifactSelection as resolvePlanningArtifactSelectionCore,
} from './approved-plan-lifecycle.js';
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

export function isApprovedExecutionFollowupReadyStatus(status: ContextPackStatus): boolean {
  return isApprovedExecutionFollowupReadyStatusCore(status);
}

export function isApprovedExecutionContextReadyStatus(status: ContextPackStatus): boolean {
  return isApprovedExecutionContextReadyStatusCore(status);
}

const APPROVED_REPOSITORY_CONTEXT_MAX_CHARS = 4_000;
const APPROVED_REPOSITORY_CONTEXT_MAX_LINES = 80;

export interface PlanningArtifacts {
  plansDir: string;
  specsDir: string;
  contextDir: string;
  prdPaths: string[];
  testSpecPaths: string[];
  deepInterviewSpecPaths: string[];
  contextPackPaths: string[];
}

export interface ApprovedRepositoryContextSummary {
  sourcePath: string;
  content: string;
  truncated: boolean;
}

export interface ApprovedPlanContext {
  sourcePath: string;
  testSpecPaths: string[];
  deepInterviewSpecPaths: string[];
  contextPack: ContextPackRef | null;
  contextPackStatus: ContextPackStatus;
  missingRequiredContextPackRoles: ContextPackRole[];
  contextPackIssues: string[];
  contextRefs: ContextPackExecutionRef[];
  contextRefIssues: string[];
  repositoryContextSummary?: ApprovedRepositoryContextSummary;
}

export interface ApprovedExecutionLaunchHint extends ApprovedPlanContext {
  mode: 'team' | 'ralph';
  command: string;
  task: string;
  workerCount?: number;
  agentType?: string;
  linkedRalph?: boolean;
}

export type ApprovedExecutionLaunchHintOutcome =
  | { status: 'absent' }
  | { status: 'ambiguous' }
  | { status: 'resolved'; hint: ApprovedExecutionLaunchHint };

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

interface ApprovedExecutionLaunchHintReadOptions {
  materializeContextRefs?: boolean;
  prdPath?: string;
  task?: string;
  command?: string;
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

export interface TeamDagArtifactResolution {
  source: 'json-sidecar' | 'markdown-handoff' | 'none';
  prdPath: string | null;
  planSlug: string | null;
  artifactPath?: string;
  content?: string;
  warnings: string[];
}

function matchesTeamDagSidecarSlug(fileName: string, slug: string): boolean {
  const prefix = `team-dag-${slug}`;
  return (fileName === `${prefix}.json` || fileName.startsWith(`${prefix}-`)) && fileName.endsWith('.json');
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
  return readPlanningArtifactsCore(cwd);
}

function resolvePlanningArtifactSelection(
  artifacts: PlanningArtifacts,
  prdPath?: string | null,
): LatestPlanningArtifactSelection {
  return resolvePlanningArtifactSelectionCore(artifacts, prdPath);
}

export function hasApprovedPlanBaseline(
  artifacts: PlanningArtifacts,
  prdPath?: string | null,
): boolean {
  const selection = resolvePlanningArtifactSelection(artifacts, prdPath);
  if (!selection.prdPath || !existsSync(selection.prdPath)) {
    return false;
  }
  return selection.testSpecPaths.length > 0;
}

export function isPlanningComplete(
  artifacts: PlanningArtifacts,
  prdPath?: string | null,
): boolean {
  if (!hasApprovedPlanBaseline(artifacts, prdPath)) {
    return false;
  }
  const selection = resolvePlanningArtifactSelection(artifacts, prdPath);
  return isApprovedExecutionFollowupReadyStatus(selection.contextPackStatus);
}

export function hasRequiredContextPacks(
  artifacts: PlanningArtifacts,
  prdPath?: string | null,
): boolean {
  const selection = resolvePlanningArtifactSelection(artifacts, prdPath);
  return selection.contextPackStatus === 'ready';
}

function decodeQuotedValue(raw: string): string | null {
  const normalized = raw.trim();
  if (!normalized) return null;
  try {
    return JSON.parse(normalized) as string;
  } catch {
    if (
      (normalized.startsWith('"') && normalized.endsWith('"'))
      || (normalized.startsWith("'") && normalized.endsWith("'"))
    ) {
      return normalized.slice(1, -1);
    }
    return null;
  }
}

function orderedPrdPathsNewestFirst(paths: readonly string[]): string[] {
  return [...paths].sort(comparePlanningArtifactPaths).reverse();
}

export function resolveContextPackHandoffState(input: {
  baselineState: ContextPackBaselineState;
  outcomeState: ContextPackOutcomeState;
  packState: ContextPackPackState;
  roleCoverage: ContextPackRoleCoverageState;
  basisState: ContextPackBasisState;
  indexState: ContextPackIndexState;
}): ContextPackStatus {
  return resolveContextPackHandoffStateCore(input);
}

function resolveApprovedExecutionRefs(
  repoRoot: string,
  prdPath: string,
  contextPack: ContextPackRef | null,
): { refs: ContextPackExecutionRef[]; issues: string[] } {
  if (!contextPack) {
    return { refs: [], issues: [] };
  }
  const slug = planningArtifactSlug(prdPath, 'prd');
  return materializeContextPackRefs({
    packPath: contextPack.path,
    expectedSlug: slug ?? '',
    repoRoot,
    requireFreshBasis: true,
    roles: REQUIRED_CONTEXT_PACK_ROLES,
  });
}

export function readContextPackHandoffStatus(repoRoot: string, packPath: string): ContextPackHandoffStatusSnapshot {
  return readContextPackHandoffStatusCore(repoRoot, packPath);
}

function boundedRepositoryContextSummary(sourcePath: string, content: string): ApprovedRepositoryContextSummary | null {
  const normalizedLines = content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd());
  const trimmed = normalizedLines.join('\n').trim();
  if (!trimmed) return null;

  const limitedLines = normalizedLines.slice(0, APPROVED_REPOSITORY_CONTEXT_MAX_LINES);
  const lineTruncated = normalizedLines.length > limitedLines.length;
  let limited = limitedLines.join('\n').trim();
  let charTruncated = false;
  if (limited.length > APPROVED_REPOSITORY_CONTEXT_MAX_CHARS) {
    limited = limited.slice(0, APPROVED_REPOSITORY_CONTEXT_MAX_CHARS).trimEnd();
    charTruncated = true;
  }
  return { sourcePath, content: limited, truncated: lineTruncated || charTruncated };
}

function extractApprovedRepositoryContextSection(sourcePath: string, content: string): ApprovedRepositoryContextSummary | null {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const headingIndex = lines.findIndex((line) => /^#{1,6}\s+Approved Repository Context Summary\s*$/i.test(line.trim()));
  if (headingIndex < 0) return null;
  const headingLevel = lines[headingIndex].match(/^(#+)/)?.[1].length ?? 1;
  const body: string[] = [];
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const heading = lines[index].match(/^(#{1,6})\s+/);
    if (heading && heading[1].length <= headingLevel) break;
    body.push(lines[index]);
  }
  return boundedRepositoryContextSummary(sourcePath, body.join('\n'));
}

function readApprovedRepositoryContextSummary(
  artifacts: PlanningArtifacts,
  prdPath: string,
  planSlug: string | null,
  prdContent: string,
): ApprovedRepositoryContextSummary | null {
  if (!planSlug) return extractApprovedRepositoryContextSection(prdPath, prdContent);
  const sidecarPath = join(artifacts.plansDir, `repo-context-${planSlug}.md`);
  if (existsSync(sidecarPath)) {
    try {
      const sidecar = boundedRepositoryContextSummary(sidecarPath, readFileSync(sidecarPath, 'utf-8'));
      if (sidecar) return sidecar;
    } catch {
      // Fall through to an inline approved PRD section when the inspectable sidecar is unreadable.
    }
  }
  return extractApprovedRepositoryContextSection(prdPath, prdContent);
}

function readApprovedPlanText(
  cwd: string,
  options: ApprovedExecutionLaunchHintReadOptions = {},
): { content: string; context: ApprovedPlanContext } | null {
  const artifacts = readPlanningArtifacts(cwd);
  const selection = resolvePlanningArtifactSelection(artifacts, options.prdPath);
  const latestPrdPath = selection.prdPath;
  const canonicalPrdPath = selection.canonicalPrdPath ?? latestPrdPath;
  if (!latestPrdPath || !existsSync(latestPrdPath)) return null;

  try {
    const content = readFileSync(latestPrdPath, 'utf-8');
    const planSlug = planningArtifactSlug(canonicalPrdPath ?? latestPrdPath, 'prd');
    const repositoryContextSummary = readApprovedRepositoryContextSummary(
      artifacts,
      latestPrdPath,
      planSlug,
      content,
    );
    const repoRoot = dirname(dirname(artifacts.plansDir));
    const shouldMaterializeContextRefs = options.materializeContextRefs === true;
    const refResolution = shouldMaterializeContextRefs && selection.contextPackStatus === 'ready' && canonicalPrdPath
      ? resolveApprovedExecutionRefs(repoRoot, canonicalPrdPath, selection.contextPack)
      : { refs: [], issues: [] };
    const contextPackIssues = [...selection.contextPackIssues];
    const contextRefIssues = [...refResolution.issues];
    const contextPackStatus = shouldMaterializeContextRefs && contextRefIssues.length > 0
      ? 'invalid'
      : selection.contextPackStatus;
    if (shouldMaterializeContextRefs && contextRefIssues.length > 0) {
      contextPackIssues.push(...contextRefIssues);
    }
    return {
      content,
      context: {
        sourcePath: latestPrdPath,
        testSpecPaths: selection.testSpecPaths,
        deepInterviewSpecPaths: selection.deepInterviewSpecPaths,
        contextPack: selection.contextPack,
        contextPackStatus,
        missingRequiredContextPackRoles: selection.missingRequiredContextPackRoles,
        contextPackIssues,
        contextRefs: refResolution.refs,
        contextRefIssues,
        ...(repositoryContextSummary ? { repositoryContextSummary } : {}),
        ...(repositoryContextSummary ? { repositoryContextSummary } : {}),
      },
    };
  } catch {
    return null;
  }
}

export function selectLatestPlanningArtifacts(
  artifacts: PlanningArtifacts,
): LatestPlanningArtifactSelection {
  return resolvePlanningArtifactSelection(artifacts);
}

export function readLatestPlanningArtifacts(cwd: string): LatestPlanningArtifactSelection {
  return selectLatestPlanningArtifacts(readPlanningArtifacts(cwd));
}

function extractTeamDagMarkdownHandoff(content: string): string | null {
  const fencePattern = /```(?:json)?\s*\n(?<body>[\s\S]*?)```/gi;
  let searchFrom = 0;
  while (searchFrom < content.length) {
    const headingIndex = content.toLowerCase().indexOf('team dag handoff', searchFrom);
    if (headingIndex < 0) return null;
    fencePattern.lastIndex = headingIndex;
    const match = fencePattern.exec(content);
    if (match?.groups?.body) {
      return match.groups.body.trim();
    }
    searchFrom = headingIndex + 'team dag handoff'.length;
  }
  return null;
}

export function readTeamDagArtifactResolution(cwd: string): TeamDagArtifactResolution {
  const artifacts = readPlanningArtifacts(cwd);
  const selection = selectLatestPlanningArtifacts(artifacts);
  const prdPath = selection.prdPath;
  const planSlug = prdPath ? planningArtifactSlug(prdPath, 'prd') : null;
  if (!prdPath || !planSlug) {
    return { source: 'none', prdPath, planSlug, warnings: ['missing_prd_slug'] };
  }
  if (selection.testSpecPaths.length === 0) {
    return { source: 'none', prdPath, planSlug, warnings: ['missing_matching_test_spec'] };
  }
  if (!isApprovedExecutionFollowupReadyStatus(selection.contextPackStatus)) {
    return { source: 'none', prdPath, planSlug, warnings: [`context_pack_not_followup_ready:${selection.contextPackStatus}`] };
  }

  const sidecarPaths = readMatchingPaths(
    artifacts.plansDir,
    new RegExp(`^team-dag-${planSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:-.+)?\\.json$`, 'i'),
  ).filter((path) => matchesTeamDagSidecarSlug(basename(path), planSlug));
  if (sidecarPaths.length > 0) {
    const sidecarPath = sidecarPaths.at(-1)!;
    try {
      return {
        source: 'json-sidecar',
        prdPath,
        planSlug,
        artifactPath: sidecarPath,
        content: readFileSync(sidecarPath, 'utf-8'),
        warnings: sidecarPaths.length > 1 ? ['multiple_matches'] : [],
      };
    } catch {
      return { source: 'none', prdPath, planSlug, artifactPath: sidecarPath, warnings: ['sidecar_unreadable'] };
    }
  }

  try {
    const prdContent = readFileSync(prdPath, 'utf-8');
    const markdownHandoff = extractTeamDagMarkdownHandoff(prdContent);
    if (markdownHandoff) {
      return { source: 'markdown-handoff', prdPath, planSlug, content: markdownHandoff, warnings: [] };
    }
  } catch {
    return { source: 'none', prdPath, planSlug, warnings: ['prd_unreadable'] };
  }

  return { source: 'none', prdPath, planSlug, warnings: [] };
}

type LaunchHintSelection =
  | { status: 'no-match' }
  | { status: 'ambiguous' }
  | { status: 'unique'; match: RegExpMatchArray; task: string };

type SameTaskLineageFallback =
  | { status: 'resolved'; hint: ApprovedExecutionLaunchHint }
  | { status: 'ambiguous' }
  | { status: 'none' };

function sameTeamLaunchSignature(
  anchor: ApprovedExecutionLaunchHint,
  candidate: ApprovedExecutionLaunchHint,
): boolean {
  return anchor.task.trim() === candidate.task.trim()
    && anchor.workerCount === candidate.workerCount
    && (anchor.agentType ?? null) === (candidate.agentType ?? null)
    && Boolean(anchor.linkedRalph) === Boolean(candidate.linkedRalph);
}

function sameLaunchLineage(
  mode: 'team' | 'ralph',
  anchor: ApprovedExecutionLaunchHint,
  candidate: ApprovedExecutionLaunchHint,
): boolean {
  if (anchor.task.trim() !== candidate.task.trim()) {
    return false;
  }
  return mode === 'team'
    ? sameTeamLaunchSignature(anchor, candidate)
    : true;
}

function sameTeamLaunchSignatureMatch(
  anchor: ApprovedExecutionLaunchHint,
  match: RegExpMatchArray,
  task: string,
): boolean {
  const groups = match.groups;
  if (!groups) {
    return false;
  }
  const workerCount = Number.parseInt(groups.count ?? '', 10);
  if (!Number.isFinite(workerCount)) {
    return false;
  }
  return anchor.task.trim() === task.trim()
    && anchor.workerCount === workerCount
    && (anchor.agentType ?? null) === (groups.role || null)
    && Boolean(anchor.linkedRalph) === Boolean(groups.ralph?.trim());
}

function launchHintPattern(mode: 'team' | 'ralph'): RegExp {
  return mode === 'team'
    ? /(?<command>(?:omx\s+team|\$team)\s+(?<ralph>ralph\s+)?(?<count>\d+)(?::(?<role>[a-z][a-z0-9-]*))?\s+(?<task>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))/gi
    : /(?<command>(?:omx\s+ralph|\$ralph)\s+(?<task>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))/gi;
}

function collectLaunchHintMatches(
  content: string,
  mode: 'team' | 'ralph',
): RegExpMatchArray[] {
  return collectMarkdownVisibleMatches(content, launchHintPattern(mode));
}

function selectLaunchHintMatch(
  matches: RegExpMatchArray[],
  taskGroup: string,
  commandGroup: string,
  normalizedTask?: string,
  normalizedCommand?: string,
  matchFilter?: (match: RegExpMatchArray, task: string) => boolean,
): LaunchHintSelection {
  if (normalizedCommand) {
    const exactMatches = matches.flatMap((match) => {
      const command = match.groups?.[commandGroup]?.trim();
      if (!command || command !== normalizedCommand) {
        return [];
      }
      const rawTask = match.groups?.[taskGroup];
      if (!rawTask) {
        return [];
      }
      const task = decodeQuotedValue(rawTask);
      if (!task) {
        return [];
      }
      if (matchFilter && !matchFilter(match, task)) {
        return [];
      }
      return [{ match, task }];
    });
    if (exactMatches.length === 0) {
      return { status: 'no-match' };
    }
    if (exactMatches.length > 1) {
      return { status: 'ambiguous' };
    }
    return { status: 'unique', ...exactMatches[0]! };
  }

  if (!normalizedTask) {
    const decodedMatches = matches.flatMap((match) => {
      const rawTask = match.groups?.[taskGroup];
      if (!rawTask) {
        return [];
      }
      const task = decodeQuotedValue(rawTask);
      if (!task) {
        return [];
      }
      if (matchFilter && !matchFilter(match, task)) {
        return [];
      }
      return [{ match, task }];
    });
    if (decodedMatches.length === 0) {
      return { status: 'no-match' };
    }
    if (decodedMatches.length > 1) {
      return { status: 'ambiguous' };
    }
    return { status: 'unique', ...decodedMatches[0]! };
  }

  const exactMatches = matches.flatMap((match) => {
    const rawTask = match.groups?.[taskGroup];
    if (!rawTask) {
      return [];
    }
    const task = decodeQuotedValue(rawTask);
    if (!task || task.trim() !== normalizedTask) {
      return [];
    }
    if (matchFilter && !matchFilter(match, task)) {
      return [];
    }
    return [{ match, task }];
  });
  if (exactMatches.length === 0) {
    return { status: 'no-match' };
  }
  if (exactMatches.length > 1) {
    return { status: 'ambiguous' };
  }
  return { status: 'unique', ...exactMatches[0]! };
}

function resolveOlderReusableSameTaskHint(
  cwd: string,
  mode: 'team' | 'ralph',
  artifacts: PlanningArtifacts,
  latestPrdPath: string,
  anchorHint: ApprovedExecutionLaunchHint,
): SameTaskLineageFallback {
  const orderedPrdPaths = [...artifacts.prdPaths].sort(comparePlanningArtifactPaths);
  const latestIndex = orderedPrdPaths.lastIndexOf(latestPrdPath);
  if (latestIndex <= 0) {
    return { status: 'none' };
  }

  for (let index = latestIndex - 1; index >= 0; index -= 1) {
    const prdPath = orderedPrdPaths[index]!;
    const approvedPlan = readApprovedPlanText(cwd, { prdPath });
    if (!approvedPlan) {
      continue;
    }

    const matches = collectLaunchHintMatches(approvedPlan.content, mode);
    const selection = selectLaunchHintMatch(
      matches,
      'task',
      'command',
      anchorHint.task,
      undefined,
      mode === 'team'
        ? (match, task) => sameTeamLaunchSignatureMatch(anchorHint, match, task)
        : undefined,
    );
    if (selection.status === 'ambiguous') {
      return { status: 'ambiguous' };
    }
    if (selection.status === 'no-match') {
      continue;
    }

    const selectedCommand = selection.match.groups?.command?.trim();
    const approvedHint = readApprovedExecutionLaunchHint(cwd, mode, selectedCommand
      ? {
        command: selectedCommand,
        prdPath,
      }
      : {
        task: selection.task,
        prdPath,
      });
    if (!approvedHint) {
      continue;
    }
    if (!sameLaunchLineage(mode, anchorHint, approvedHint)) {
      continue;
    }
    if (isApprovedExecutionFollowupReadyStatus(approvedHint.contextPackStatus)) {
      return { status: 'resolved', hint: approvedHint };
    }
  }

  return { status: 'none' };
}

export function readApprovedExecutionLaunchHintOutcome(
  cwd: string,
  mode: 'team' | 'ralph',
  options: ApprovedExecutionLaunchHintReadOptions = {},
): ApprovedExecutionLaunchHintOutcome {
  const normalizedTask = options.task?.trim();
  const normalizedCommand = options.command?.trim();
  if (!normalizedTask && !normalizedCommand && !options.prdPath) {
    const artifacts = readPlanningArtifacts(cwd);
    const latestPrdPath = selectLatestPlanningArtifactPath(artifacts.prdPaths);
    if (!latestPrdPath) {
      return { status: 'absent' };
    }

    const latestApprovedHintOutcome = readApprovedExecutionLaunchHintOutcome(cwd, mode, {
      ...options,
      prdPath: latestPrdPath,
    });
    if (latestApprovedHintOutcome.status === 'ambiguous') {
      return { status: 'ambiguous' };
    }
    if (latestApprovedHintOutcome.status !== 'resolved') {
      return { status: 'absent' };
    }
    const latestApprovedHint = latestApprovedHintOutcome.hint;
    if (isApprovedExecutionFollowupReadyStatus(latestApprovedHint.contextPackStatus)) {
      return { status: 'resolved', hint: latestApprovedHint };
    }
    const sameTaskFallback = resolveOlderReusableSameTaskHint(
      cwd,
      mode,
      artifacts,
      latestPrdPath,
      latestApprovedHint,
    );
    if (sameTaskFallback.status === 'ambiguous') {
      return { status: 'ambiguous' };
    }
    return sameTaskFallback.status === 'resolved'
      ? { status: 'resolved', hint: sameTaskFallback.hint }
      : { status: 'resolved', hint: latestApprovedHint };
  }

  if ((normalizedTask || normalizedCommand) && !options.prdPath) {
    const artifacts = readPlanningArtifacts(cwd);
    let newestNonReusableHint: ApprovedExecutionLaunchHint | null = null;
    let lineageAnchorHint: ApprovedExecutionLaunchHint | null = null;
    for (const prdPath of orderedPrdPathsNewestFirst(artifacts.prdPaths)) {
      const approvedPlan = readApprovedPlanText(cwd, {
        ...options,
        prdPath,
      });
      if (!approvedPlan) {
        continue;
      }
      const matches = collectLaunchHintMatches(approvedPlan.content, mode);
      const teamLineageFilter = (() => {
        if (!(mode === 'team' && normalizedTask && !normalizedCommand && lineageAnchorHint)) {
          return undefined;
        }
        const anchorHint = lineageAnchorHint;
        return (match: RegExpMatchArray, task: string) => sameTeamLaunchSignatureMatch(anchorHint, match, task);
      })();
      const selection = selectLaunchHintMatch(
        matches,
        'task',
        'command',
        normalizedTask,
        normalizedCommand,
        teamLineageFilter,
      );
      if (selection.status === 'ambiguous') {
        return { status: 'ambiguous' };
      }
      if (selection.status !== 'unique') {
        continue;
      }
      const selectedCommand = selection.match.groups?.command?.trim();
      const approvedHintOutcome = readApprovedExecutionLaunchHintOutcome(cwd, mode, selectedCommand
        ? {
          ...options,
          prdPath,
          command: selectedCommand,
        }
        : {
          ...options,
          prdPath,
          task: selection.task,
        });
      if (approvedHintOutcome.status !== 'resolved') {
        if (approvedHintOutcome.status === 'ambiguous') {
          return { status: 'ambiguous' };
        }
        continue;
      }
      const approvedHint = approvedHintOutcome.hint;
      if (mode === 'team' && normalizedTask && !normalizedCommand) {
        lineageAnchorHint ??= approvedHint;
      }
      if (isApprovedExecutionFollowupReadyStatus(approvedHint.contextPackStatus)) {
        return { status: 'resolved', hint: approvedHint };
      }
      newestNonReusableHint ??= approvedHint;
    }
    return newestNonReusableHint
      ? { status: 'resolved', hint: newestNonReusableHint }
      : { status: 'absent' };
  }

  const approvedPlan = readApprovedPlanText(cwd, options);
  if (!approvedPlan) return { status: 'absent' };

  if (mode === 'team') {
    const matches = collectLaunchHintMatches(approvedPlan.content, mode);
    const selected = selectLaunchHintMatch(matches, 'task', 'command', normalizedTask, normalizedCommand);
    if (selected.status === 'ambiguous') return { status: 'ambiguous' };
    if (selected.status !== 'unique' || !selected.match.groups) return { status: 'absent' };
    return {
      status: 'resolved',
      hint: {
        mode,
        command: selected.match.groups.command,
        task: selected.task,
        workerCount: Number.parseInt(selected.match.groups.count, 10),
        agentType: selected.match.groups.role || undefined,
        linkedRalph: Boolean(selected.match.groups.ralph?.trim()),
        ...approvedPlan.context,
      },
    };
  }

  const matches = collectLaunchHintMatches(approvedPlan.content, mode);
  const selected = selectLaunchHintMatch(matches, 'task', 'command', normalizedTask, normalizedCommand);
  if (selected.status === 'ambiguous') return { status: 'ambiguous' };
  if (selected.status !== 'unique' || !selected.match.groups) return { status: 'absent' };
  return {
    status: 'resolved',
    hint: {
      mode,
      command: selected.match.groups.command,
      task: selected.task,
      ...approvedPlan.context,
    },
  };
}

export function readApprovedExecutionLaunchHint(
  cwd: string,
  mode: 'team' | 'ralph',
  options: ApprovedExecutionLaunchHintReadOptions = {},
): ApprovedExecutionLaunchHint | null {
  const outcome = readApprovedExecutionLaunchHintOutcome(cwd, mode, options);
  return outcome.status === 'resolved' ? outcome.hint : null;
}
