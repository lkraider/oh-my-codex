import { createHash } from 'node:crypto';
import { basename, join, relative } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const CONTEXT_PACK_INDEX_ROLE_ORDER = ['build', 'verify', 'scope'] as const;
const CONTEXT_PACK_VIEW_NOTES_START = '<!-- OMX:CONTEXT:VIEW-NOTES:START -->';
const CONTEXT_PACK_VIEW_NOTES_END = '<!-- OMX:CONTEXT:VIEW-NOTES:END -->';
const CONTEXT_PACK_VIEW_NOTES_PLACEHOLDER = '<!-- Optional planner-added notes for private context-pack index usage. Keep them concise and preserve the scaffold outside this block. -->';

export type TestContextPackRole = (typeof CONTEXT_PACK_INDEX_ROLE_ORDER)[number];

export interface TestContextPackEntry {
  path: string;
  roles: readonly TestContextPackRole[];
}

export function computeGitBlobSha1(content: string): string {
  const buffer = Buffer.from(content, 'utf-8');
  const header = Buffer.from(`blob ${buffer.length}\0`, 'utf-8');
  return createHash('sha1').update(header).update(buffer).digest('hex');
}

export function canonicalContextPackRelativePath(slug: string): string {
  return `.omx/context/context-20260507T120000Z-${slug}.json`;
}

export function buildContextPackOutcome(relativePackPath: string): string {
  return [
    '## Context Pack Outcome',
    '',
    `- pack: created \`${relativePackPath}\``,
  ].join('\n');
}

export function buildContextPackEntriesFromRoles(
  roles: readonly TestContextPackRole[],
): TestContextPackEntry[] {
  return roles.map((role, index) => ({
    path: `src/${role}-${index}.ts`,
    roles: [role],
  }));
}

export function contextPackIndexFixturePath(packPath: string): string {
  return packPath.replace(/\.json$/i, '.md');
}

function groupRoleRefs(
  entries: readonly TestContextPackEntry[],
): Record<TestContextPackRole, string[]> {
  const grouped = {
    build: [] as string[],
    verify: [] as string[],
    scope: [] as string[],
  };
  const seen = {
    build: new Set<string>(),
    verify: new Set<string>(),
    scope: new Set<string>(),
  };

  for (const entry of entries) {
    for (const role of entry.roles) {
      if (seen[role].has(entry.path)) {
        continue;
      }
      seen[role].add(entry.path);
      grouped[role].push(entry.path);
    }
  }

  return grouped;
}

export function renderContextPackIndexFixture(
  packPath: string,
  slug: string,
  entries: readonly TestContextPackEntry[],
  preservedViewNotes: readonly string[] = [],
): string {
  const groupedRoleRefs = groupRoleRefs(entries);
  const roleSummary = CONTEXT_PACK_INDEX_ROLE_ORDER
    .filter((role) => groupedRoleRefs[role].length > 0)
    .map((role) => `${role}=${groupedRoleRefs[role].length}`)
    .join(', ');
  const roleIndex = CONTEXT_PACK_INDEX_ROLE_ORDER
    .filter((role) => groupedRoleRefs[role].length > 0)
    .map((role) => `- ${role} (${groupedRoleRefs[role].length}): ${groupedRoleRefs[role].join(', ')}`);

  return [
    '# Context Pack Index',
    `- pack: ${basename(packPath)}`,
    `- slug: ${slug}`,
    '',
    '## Pack Summary',
    `- entries: ${entries.length}`,
    `- role-refs: ${roleSummary || 'none'}`,
    '',
    '## Role Index',
    ...roleIndex,
    '',
    '## View Notes',
    CONTEXT_PACK_VIEW_NOTES_START,
    ...(preservedViewNotes.length > 0 ? preservedViewNotes : [CONTEXT_PACK_VIEW_NOTES_PLACEHOLDER]),
    CONTEXT_PACK_VIEW_NOTES_END,
    '',
    '## Refs',
    ...entries.map((entry) => `- ${entry.path} | roles=${entry.roles.join(',')}`),
    '',
  ].join('\n');
}

export async function writeContextPackFixture(options: {
  cwd: string;
  slug: string;
  prdPath: string;
  testSpecPath: string;
  entries: readonly TestContextPackEntry[];
  writeIndex?: boolean;
  preservedViewNotes?: readonly string[];
}): Promise<string> {
  const contextDir = join(options.cwd, '.omx', 'context');
  const packPath = join(options.cwd, canonicalContextPackRelativePath(options.slug));
  const prdContent = await readFile(options.prdPath, 'utf-8');
  const testSpecContent = await readFile(options.testSpecPath, 'utf-8');
  await mkdir(contextDir, { recursive: true });
  await writeFile(packPath, JSON.stringify({
    slug: options.slug,
    basis: {
      prd: {
        path: relative(options.cwd, options.prdPath).replaceAll('\\', '/'),
        sha1: computeGitBlobSha1(prdContent),
      },
      testSpecs: [{
        path: relative(options.cwd, options.testSpecPath).replaceAll('\\', '/'),
        sha1: computeGitBlobSha1(testSpecContent),
      }],
    },
    entries: options.entries,
  }, null, 2));

  if (options.writeIndex ?? true) {
    await writeFile(
      contextPackIndexFixturePath(packPath),
      renderContextPackIndexFixture(
        packPath,
        options.slug,
        options.entries,
        options.preservedViewNotes,
      ),
    );
  }

  return packPath;
}
