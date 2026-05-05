import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  readPlanningArtifacts,
  resolveApprovedPlanBaseline,
  resolveApprovedPlanBaselineForSlug,
  resolvePlanningArtifactSelection,
  selectBaselinePrdPathForSlug,
} from '../approved-plan-lifecycle.js';
import { comparePlanningArtifactPaths } from '../artifact-names.js';
import {
  readApprovedExecutionLaunchHint,
  readContextPackHandoffStatus,
  readLatestPlanningArtifacts,
} from '../artifacts.js';
import {
  buildContextPackBasis,
  CONTEXT_PACK_SCHEMA,
  describeContextPackBasisResolutionIssues,
  validateContextPackManifest,
  writeContextPackDocument,
} from '../context-packs.js';
import { contextToolMain } from '../context-tool.js';

type PackRole = 'scope' | 'build' | 'verify';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'omx-approved-plan-lifecycle-'));
});

afterEach(async () => {
  if (tempDir && existsSync(tempDir)) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function writePlanFiles(files: Record<string, string>): Promise<string> {
  const plansDir = join(tempDir, '.omx', 'plans');
  await mkdir(plansDir, { recursive: true });
  for (const [fileName, content] of Object.entries(files)) {
    await writeFile(join(plansDir, fileName), content);
  }
  return plansDir;
}

async function writeRepoFile(repoRelativePath: string, content: string): Promise<void> {
  const absolutePath = join(tempDir, repoRelativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content);
}

async function supportsCaseDistinctPlanArtifacts(): Promise<boolean> {
  const probeDir = join(tempDir, '.omx', 'plans', 'case-probe');
  await rm(probeDir, { recursive: true, force: true });
  await mkdir(probeDir, { recursive: true });
  await writeFile(join(probeDir, 'prd-case-probe.md'), '# exact\n');
  await writeFile(join(probeDir, 'PRD-case-probe.md'), '# variant\n');
  const entries = await readdir(probeDir);
  await rm(probeDir, { recursive: true, force: true });
  return entries.includes('prd-case-probe.md') && entries.includes('PRD-case-probe.md');
}

function packPath(slug: string): string {
  return packPathAt(slug);
}

function packPathAt(slug: string, timestamp = '20260420T000000Z'): string {
  return join(tempDir, '.omx', 'context', `context-${timestamp}-${slug}.json`);
}

function prdWithContextPackOutcome(...lines: string[]): string {
  return [
    '# PRD',
    '',
    '## Context Pack Outcome',
    ...lines,
    '',
  ].join('\n');
}

async function writeRoleDocs(
  slug: string,
  roles: readonly PackRole[] = ['scope', 'build', 'verify'],
): Promise<void> {
  for (const role of roles) {
    await writeRepoFile(`docs/${slug}-${role}.md`, `# ${role}\n\n${role}\n`);
  }
}

function buildRoleEntry(slug: string, role: PackRole, path = `docs/${slug}-${role}.md`) {
  return {
    label: role,
    path,
    roles: [role],
    tags: [],
    relationPath: [
      { tag: 'plan', target: slug },
      { tag: role === 'scope' ? 'bounds' : role === 'build' ? 'implements' : 'verifies', target: path },
    ],
  };
}

function requiredRoles(): PackRole[] {
  return ['scope', 'build', 'verify'];
}

describe('approved-plan lifecycle', () => {
  it('fails closed when planning artifact directories cannot be read as directories', async () => {
    await writeRepoFile('.omx/plans', 'not a directory');

    const artifacts = readPlanningArtifacts(tempDir);

    assert.deepEqual(artifacts.prdPaths, []);
    assert.deepEqual(artifacts.testSpecPaths, []);
    assert.deepEqual(artifacts.deepInterviewSpecPaths, []);
    assert.deepEqual(artifacts.contextPackPaths, []);
  });

  it('resolves repo-relative and plans-relative approved PRD paths and rejects missing aliases', async () => {
    const plansDir = await writePlanFiles({
      'prd-alpha.md': '# Alpha\n',
      'test-spec-alpha.md': '# Alpha Test Spec\n',
    });
    const artifacts = readPlanningArtifacts(tempDir);

    const repoRelative = resolveApprovedPlanBaseline(artifacts, '.omx/plans/prd-alpha.md');
    const plansRelative = resolveApprovedPlanBaseline(artifacts, 'prd-alpha.md');
    const missingAbsolute = resolveApprovedPlanBaseline(artifacts, join(plansDir, 'prd-missing.md'));
    const missingRelative = resolveApprovedPlanBaseline(artifacts, '.omx/plans/prd-missing.md');

    assert.equal(repoRelative.prdPath, join(plansDir, 'prd-alpha.md'));
    assert.equal(repoRelative.canonicalPrdPath, join(plansDir, 'prd-alpha.md'));
    assert.deepEqual(repoRelative.testSpecPaths, [join(plansDir, 'test-spec-alpha.md')]);
    assert.equal(plansRelative.prdPath, join(plansDir, 'prd-alpha.md'));
    assert.equal(plansRelative.canonicalPrdPath, join(plansDir, 'prd-alpha.md'));
    assert.equal(missingAbsolute.baselineState, 'missing-prd');
    assert.equal(missingRelative.baselineState, 'missing-prd');
  });

  it('accepts equivalent relative approved PRD paths through canonical file identity', async () => {
    const plansDir = await writePlanFiles({
      'prd-alpha.md': '# Alpha\n',
      'test-spec-alpha.md': '# Alpha Test Spec\n',
    });
    const artifacts = readPlanningArtifacts(tempDir);
    const equivalentRelativePath = `../${basename(tempDir)}/.omx/plans/prd-alpha.md`;

    const baseline = resolveApprovedPlanBaseline(artifacts, equivalentRelativePath);

    assert.equal(baseline.prdPath, join(plansDir, 'prd-alpha.md'));
    assert.equal(baseline.canonicalPrdPath, join(plansDir, 'prd-alpha.md'));
    assert.deepEqual(baseline.testSpecPaths, [join(plansDir, 'test-spec-alpha.md')]);
  });

  it('reports missing-prd when no canonical approved plan can be resolved', () => {
    const baseline = resolveApprovedPlanBaseline(
      readPlanningArtifacts(tempDir),
      join(tempDir, '.omx', 'plans', 'prd-missing.md'),
    );

    assert.equal(baseline.baselineState, 'missing-prd');
    assert.equal(baseline.prdPath, null);
    assert.equal(baseline.canonicalPrdPath, null);
    assert.deepEqual(baseline.testSpecPaths, []);
    assert.deepEqual(baseline.baselineIssues, []);
    assert.equal(baseline.basis, undefined);
  });

  it('keeps legacy PRDs compatible with both legacy test-spec spellings', async () => {
    const plansDir = await writePlanFiles({
      'prd-alpha.md': '# Alpha\n',
      'test-spec-alpha.md': '# Alpha Test Spec\n',
      'testspec-alpha.md': '# Alpha Compatibility Test Spec\n',
    });
    const artifacts = readPlanningArtifacts(tempDir);

    const baseline = resolveApprovedPlanBaseline(
      artifacts,
      join(plansDir, 'prd-alpha.md'),
    );
    const hydratedBaseline = resolveApprovedPlanBaseline(
      artifacts,
      join(plansDir, 'prd-alpha.md'),
      { includeBasis: true },
    );

    assert.equal(baseline.baselineState, 'present');
    assert.deepEqual(baseline.testSpecPaths, [
      join(plansDir, 'test-spec-alpha.md'),
      join(plansDir, 'testspec-alpha.md'),
    ]);
    assert.deepEqual(baseline.baselineIssues, []);
    assert.equal(baseline.basis, undefined);
    assert.ok(hydratedBaseline.basis);
    assert.deepEqual(
      hydratedBaseline.basis?.testSpecs.map((testSpec) => testSpec.path),
      [
        '.omx/plans/test-spec-alpha.md',
        '.omx/plans/testspec-alpha.md',
      ],
    );
  });

  it('falls back to a legacy case-variant PRD when no exact prd-<slug>.md exists', async () => {
    const plansDir = await writePlanFiles({
      'PRD-alpha.md': '# Alpha\n',
      'test-spec-alpha.md': '# Alpha Test Spec\n',
    });

    const baseline = resolveApprovedPlanBaselineForSlug(tempDir, 'alpha', { includeBasis: true });

    assert.equal(baseline.baselineState, 'present');
    assert.equal(baseline.prdPath, join(plansDir, 'PRD-alpha.md'));
    assert.equal(baseline.canonicalPrdPath, join(plansDir, 'PRD-alpha.md'));
    assert.deepEqual(baseline.testSpecPaths, [join(plansDir, 'test-spec-alpha.md')]);
    assert.equal(baseline.basis?.prd.path, '.omx/plans/PRD-alpha.md');
  });

  it('selects slug-based baseline PRDs deterministically without filesystem case assumptions', () => {
    const variantOnlyPaths = [
      join(tempDir, '.omx', 'plans', 'PRD-alpha.md'),
      join(tempDir, '.omx', 'plans', 'prd-alpha.MD'),
    ];

    assert.equal(
      selectBaselinePrdPathForSlug([
        join(tempDir, '.omx', 'plans', 'prd-alpha.md'),
        join(tempDir, '.omx', 'plans', 'PRD-alpha.md'),
      ], 'alpha'),
      join(tempDir, '.omx', 'plans', 'prd-alpha.md'),
    );

    assert.equal(
      selectBaselinePrdPathForSlug([
        join(tempDir, '.omx', 'plans', 'PRD-alpha.md'),
        join(tempDir, '.omx', 'plans', 'prd-20260427T153000Z-alpha.md'),
        join(tempDir, '.omx', 'plans', 'prd-20260427T153100Z-alpha.md'),
      ], 'alpha'),
      join(tempDir, '.omx', 'plans', 'prd-20260427T153100Z-alpha.md'),
    );

    assert.equal(
      selectBaselinePrdPathForSlug(variantOnlyPaths, 'alpha'),
      [...variantOnlyPaths].sort(comparePlanningArtifactPaths).at(-1) ?? null,
    );

    assert.equal(
      selectBaselinePrdPathForSlug([
        join(tempDir, '.omx', 'plans', 'prd-beta.md'),
      ], 'alpha'),
      null,
    );
  });

  it('accepts only the canonical same-timestamp test spec for timestamped PRDs', async () => {
    const plansDir = await writePlanFiles({
      'prd-20260427T153000Z-beta.md': '# Beta\n',
      'test-spec-20260427T153000Z-beta.md': '# Beta Canonical Test Spec\n',
      'testspec-20260427T153000Z-beta.md': '# Beta Deprecated Alias\n',
    });
    const artifacts = readPlanningArtifacts(tempDir);

    const baseline = resolveApprovedPlanBaseline(
      artifacts,
      join(plansDir, 'prd-20260427T153000Z-beta.md'),
    );
    const hydratedBaseline = resolveApprovedPlanBaseline(
      artifacts,
      join(plansDir, 'prd-20260427T153000Z-beta.md'),
      { includeBasis: true },
    );

    assert.equal(baseline.baselineState, 'present');
    assert.deepEqual(baseline.testSpecPaths, [
      join(plansDir, 'test-spec-20260427T153000Z-beta.md'),
    ]);
    assert.deepEqual(baseline.baselineIssues, []);
    assert.equal(baseline.basis, undefined);
    assert.deepEqual(
      hydratedBaseline.basis?.testSpecs.map((testSpec) => testSpec.path),
      ['.omx/plans/test-spec-20260427T153000Z-beta.md'],
    );
  });

  it('reports timestamped missing-baseline guidance when only same-slug near-miss files exist', async () => {
    const plansDir = await writePlanFiles({
      'prd-20260427T153000Z-gamma.md': '# Gamma\n',
      'test-spec-gamma.md': '# Gamma Legacy Test Spec\n',
      'testspec-gamma.md': '# Gamma Compatibility Test Spec\n',
    });

    const baseline = resolveApprovedPlanBaseline(
      readPlanningArtifacts(tempDir),
      join(plansDir, 'prd-20260427T153000Z-gamma.md'),
    );

    assert.equal(baseline.baselineState, 'missing-test-spec');
    assert.deepEqual(baseline.testSpecPaths, []);
    assert.deepEqual(baseline.baselineIssues, [
      'Approved plan is missing a matching test spec.',
      'Approved timestamped plan requires test spec `test-spec-20260427T153000Z-gamma.md`.',
      'Found non-matching test-spec files: `test-spec-gamma.md`, `testspec-gamma.md`.',
    ]);
    assert.equal(baseline.basis, undefined);
  });

  it('does not let deprecated timestamped testspec aliases satisfy timestamped baselines', async () => {
    const plansDir = await writePlanFiles({
      'prd-20260427T153000Z-delta.md': '# Delta\n',
      'testspec-20260427T153000Z-delta.md': '# Delta Deprecated Timestamped Alias\n',
    });

    const baseline = resolveApprovedPlanBaseline(
      readPlanningArtifacts(tempDir),
      join(plansDir, 'prd-20260427T153000Z-delta.md'),
    );

    assert.equal(baseline.baselineState, 'missing-test-spec');
    assert.deepEqual(baseline.testSpecPaths, []);
    assert.deepEqual(baseline.baselineIssues, [
      'Approved plan is missing a matching test spec.',
      'Approved timestamped plan requires test spec `test-spec-20260427T153000Z-delta.md`.',
      'Found non-matching test-spec files: `testspec-20260427T153000Z-delta.md`.',
    ]);
  });

  it('treats malformed context-pack outcome declarations as invalid', async () => {
    const cases = [
      {
        slug: 'invalid-outcome-line',
        outcomeLines: ['- pack: created'],
        expectedIssues: ['Invalid Context Pack Outcome line: - pack: created'],
      },
      {
        slug: 'invalid-outcome-path',
        outcomeLines: ['- pack: created `docs/not-a-pack.json`'],
        expectedIssues: ['Context Pack Outcome must point to .omx/context/context-<timestamp>-<slug>.json.'],
      },
      {
        slug: 'missing-outcome-declaration',
        outcomeLines: ['- note: still drafting'],
        expectedIssues: ['Context Pack Outcome must declare exactly one pack.'],
      },
    ] as const;

    for (const testCase of cases) {
      await writePlanFiles({
        [`prd-${testCase.slug}.md`]: prdWithContextPackOutcome(...testCase.outcomeLines),
        [`test-spec-${testCase.slug}.md`]: '# Test Spec\n',
      });
    }

    const artifacts = readPlanningArtifacts(tempDir);
    for (const testCase of cases) {
      const selection = resolvePlanningArtifactSelection(
        artifacts,
        join(tempDir, '.omx', 'plans', `prd-${testCase.slug}.md`),
      );

      assert.equal(selection.contextPackStatus, 'invalid');
      assert.equal(selection.contextPack, null);
      assert.deepEqual(selection.contextPackIssues, testCase.expectedIssues);
    }
  });

  it('keeps the first parsed pack ref when a later malformed declaration invalidates the outcome', async () => {
    const slug = 'partially-valid-outcome';
    await writePlanFiles({
      [`prd-${slug}.md`]: prdWithContextPackOutcome(
        `- pack: created \`.omx/context/context-20260420T000000Z-${slug}.json\``,
        '- pack: created',
      ),
      [`test-spec-${slug}.md`]: '# Test Spec\n',
    });

    const selection = readLatestPlanningArtifacts(tempDir);

    assert.equal(selection.contextPackStatus, 'invalid');
    assert.equal(selection.contextPack?.path, packPath(slug));
    assert.deepEqual(selection.missingRequiredContextPackRoles, requiredRoles());
    assert.deepEqual(selection.contextPackIssues, ['Invalid Context Pack Outcome line: - pack: created']);
  });

  it('treats duplicate pack declarations inside one outcome section as ambiguous', async () => {
    const slug = 'duplicate-pack-declaration';
    await writePlanFiles({
      [`prd-${slug}.md`]: prdWithContextPackOutcome(
        `- pack: created \`.omx/context/context-20260420T000000Z-${slug}.json\``,
        `- pack: refreshed \`.omx/context/context-20260421T000000Z-${slug}.json\``,
      ),
      [`test-spec-${slug}.md`]: '# Test Spec\n',
    });

    const selection = readLatestPlanningArtifacts(tempDir);

    assert.equal(selection.contextPackStatus, 'invalid');
    assert.equal(selection.contextPack, null);
    assert.deepEqual(selection.contextPackIssues, ['Context Pack Outcome may declare only one pack.']);
  });

  it('treats missing declared pack files as incomplete', async () => {
    const slug = 'missing-declared-pack';
    await writePlanFiles({
      [`prd-${slug}.md`]: prdWithContextPackOutcome(
        `- pack: created .omx/context/context-20260420T000000Z-${slug}.json`,
      ),
      [`test-spec-${slug}.md`]: '# Test Spec\n',
    });

    const selection = readLatestPlanningArtifacts(tempDir);

    assert.equal(selection.contextPackStatus, 'incomplete');
    assert.equal(selection.contextPack?.path, packPath(slug));
    assert.deepEqual(selection.missingRequiredContextPackRoles, requiredRoles());
    assert.deepEqual(selection.contextPackIssues, [
      `Declared context pack file is missing: .omx/context/context-20260420T000000Z-${slug}.json.`,
    ]);
  });

  it('treats unreadable approved plans as invalid during latest selection', async () => {
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await mkdir(join(plansDir, 'prd-unreadable-plan.md'), { recursive: true });
    await writeFile(join(plansDir, 'test-spec-unreadable-plan.md'), '# Test Spec\n');

    const selection = readLatestPlanningArtifacts(tempDir);

    assert.equal(selection.prdPath, join(plansDir, 'prd-unreadable-plan.md'));
    assert.equal(selection.contextPackStatus, 'invalid');
    assert.deepEqual(selection.contextPackIssues, [
      'Approved plan could not be read while resolving context packs.',
    ]);
  });

  it('fails closed when pack handoff status cannot infer a slug or find an approved PRD', () => {
    const noSlugStatus = readContextPackHandoffStatus(
      tempDir,
      join(tempDir, '.omx', 'context', 'notes.json'),
    );
    const orphanStatus = readContextPackHandoffStatus(tempDir, packPath('orphan'));

    assert.equal(noSlugStatus.slug, null);
    assert.equal(noSlugStatus.baselineState, 'missing-prd');
    assert.equal(noSlugStatus.handoffState, 'missing-baseline');
    assert.equal(noSlugStatus.issues[0], 'Could not infer a context-pack slug for approved PRD lookup.');

    assert.equal(orphanStatus.slug, 'orphan');
    assert.equal(orphanStatus.packState, 'missing');
    assert.equal(orphanStatus.baselineState, 'missing-prd');
    assert.equal(orphanStatus.handoffState, 'missing-baseline');
    assert.deepEqual(orphanStatus.issues, [
      'Approved PRD is missing for slug orphan.',
      `Context pack not found: ${packPath('orphan')}`,
    ]);
  });

  it('treats invalid JSON pack files as schema-invalid during handoff inspection', async () => {
    const slug = 'invalid-json-pack';
    await writePlanFiles({
      [`prd-${slug}.md`]: prdWithContextPackOutcome(
        `- pack: created \`.omx/context/context-20260420T000000Z-${slug}.json\``,
      ),
      [`test-spec-${slug}.md`]: '# Test Spec\n',
    });
    await mkdir(join(tempDir, '.omx', 'context'), { recursive: true });
    await writeFile(packPath(slug), '{not valid json');

    const status = readContextPackHandoffStatus(tempDir, packPath(slug));

    assert.equal(status.packState, 'schema-invalid');
    assert.equal(status.handoffState, 'invalid');
    assert.ok(status.issues.includes(`Could not read context pack: ${packPath(slug)}`));
  });

  it('treats manifest-invalid context packs as invalid during handoff inspection', async () => {
    const slug = 'manifest-invalid-pack';
    await writePlanFiles({
      [`prd-${slug}.md`]: prdWithContextPackOutcome(
        `- pack: created \`.omx/context/context-20260420T000000Z-${slug}.json\``,
      ),
      [`test-spec-${slug}.md`]: '# Test Spec\n',
    });
    writeContextPackDocument(packPath(slug), {
      schema: CONTEXT_PACK_SCHEMA,
      slug,
      entries: [
        buildRoleEntry(slug, 'scope', 'docs/missing-scope.md'),
        buildRoleEntry(slug, 'build', 'docs/missing-build.md'),
        buildRoleEntry(slug, 'verify', 'docs/missing-verify.md'),
      ],
    }, { refreshBasis: true });

    const status = readContextPackHandoffStatus(tempDir, packPath(slug));

    assert.equal(status.packState, 'schema-invalid');
    assert.equal(status.handoffState, 'invalid');
    assert.ok(status.issues.includes(
      `context-20260420T000000Z-${slug}.json entry "scope" points at missing source docs/missing-scope.md.`,
    ));
  });

  it('reports missing required roles as incomplete when the pack is otherwise valid', async () => {
    const slug = 'missing-required-role-pack';
    await writeRoleDocs(slug, ['scope', 'build']);
    await writePlanFiles({
      [`prd-${slug}.md`]: prdWithContextPackOutcome(
        `- pack: created \`.omx/context/context-20260420T000000Z-${slug}.json\``,
      ),
      [`test-spec-${slug}.md`]: '# Test Spec\n',
    });
    writeContextPackDocument(packPath(slug), {
      schema: CONTEXT_PACK_SCHEMA,
      slug,
      entries: [
        buildRoleEntry(slug, 'scope'),
        buildRoleEntry(slug, 'build'),
      ],
    }, { refreshBasis: true });

    const status = readContextPackHandoffStatus(tempDir, packPath(slug));

    assert.equal(status.packState, 'valid');
    assert.equal(status.roleCoverage, 'missing-required-roles');
    assert.equal(status.handoffState, 'incomplete');
    assert.deepEqual(status.missingRequiredContextPackRoles, ['verify']);
    assert.ok(status.issues.includes('Declared context pack is missing required roles: verify.'));
  });

  it('treats unreadable pack paths as invalid during handoff inspection', async () => {
    const slug = 'unreadable-pack';
    await writePlanFiles({
      [`prd-${slug}.md`]: prdWithContextPackOutcome(
        `- pack: created \`.omx/context/context-20260420T000000Z-${slug}.json\``,
      ),
      [`test-spec-${slug}.md`]: '# Test Spec\n',
    });
    await mkdir(packPath(slug), { recursive: true });

    const status = readContextPackHandoffStatus(tempDir, packPath(slug));

    assert.equal(status.packState, 'unreadable');
    assert.equal(status.handoffState, 'invalid');
    assert.ok(status.issues.includes(`Context pack could not be read: ${packPath(slug)}`));
  });

  it('treats declared packs for other canonical paths as invalid single-other handoffs', async () => {
    const slug = 'single-other-pack';
    const declaredPack = packPathAt(slug, '20260420T000000Z');
    const queriedPack = packPathAt(slug, '20260421T000000Z');
    await writeRoleDocs(slug);
    await writePlanFiles({
      [`prd-${slug}.md`]: prdWithContextPackOutcome(
        `- pack: created \`.omx/context/context-20260420T000000Z-${slug}.json\``,
      ),
      [`test-spec-${slug}.md`]: '# Test Spec\n',
    });
    writeContextPackDocument(declaredPack, {
      schema: CONTEXT_PACK_SCHEMA,
      slug,
      entries: requiredRoles().map((role) => buildRoleEntry(slug, role)),
    }, { refreshBasis: true });
    writeContextPackDocument(queriedPack, {
      schema: CONTEXT_PACK_SCHEMA,
      slug,
      entries: requiredRoles().map((role) => buildRoleEntry(slug, role)),
    }, { refreshBasis: true });

    const status = readContextPackHandoffStatus(tempDir, queriedPack);

    assert.equal(status.outcomeState, 'single-other');
    assert.equal(status.handoffState, 'invalid');
    assert.ok(status.issues.includes(
      `Context Pack Outcome declares .omx/context/context-20260420T000000Z-${slug}.json, not ${queriedPack}.`,
    ));
  });

  it('fails closed when the approved PRD cannot be read during pack handoff inspection', async () => {
    const slug = 'unreadable-approved-prd';
    const plansDir = join(tempDir, '.omx', 'plans');
    await mkdir(plansDir, { recursive: true });
    await mkdir(join(plansDir, `prd-${slug}.md`), { recursive: true });
    await writeFile(join(plansDir, `test-spec-${slug}.md`), '# Test Spec\n');
    await writeRoleDocs(slug);
    writeContextPackDocument(packPath(slug), {
      schema: CONTEXT_PACK_SCHEMA,
      slug,
      entries: requiredRoles().map((role) => buildRoleEntry(slug, role)),
    });

    const status = readContextPackHandoffStatus(tempDir, packPath(slug));

    assert.equal(status.outcomeState, 'malformed');
    assert.equal(status.handoffState, 'invalid');
    assert.ok(status.issues.includes(`Approved PRD could not be read for slug ${slug}.`));
  });

  it('keeps timestamped missing-baseline guidance aligned across selection, hints, basis, handoff status, sync, and validation', async () => {
    const slug = 'issue-lifecycle-consistency';
    await writeRepoFile('docs/scope.md', '# Scope\n\nStay inside the approved slice.\n');
    await writeRepoFile('docs/build.md', '# Build\n\nImplement the approved slice.\n');
    await writeRepoFile('docs/verify.md', '# Verify\n\nCheck the approved slice.\n');
    await writePlanFiles({
      [`prd-20260427T153000Z-${slug}.md`]: [
        '# PRD',
        '',
        '## Context Pack Outcome',
        `- pack: created \`.omx/context/context-20260420T000000Z-${slug}.json\``,
        '',
        'Launch via omx ralph "Execute lifecycle consistency"',
      ].join('\n'),
      [`test-spec-${slug}.md`]: '# Legacy Test Spec\n',
      [`testspec-20260427T153000Z-${slug}.md`]: '# Deprecated Timestamped Alias\n',
    });
    const absolutePackPath = packPath(slug);
    writeContextPackDocument(absolutePackPath, {
      schema: CONTEXT_PACK_SCHEMA,
      slug,
      basis: {
        prd: {
          path: `.omx/plans/prd-20260427T153000Z-${slug}.md`,
          sha1: 'a'.repeat(40),
        },
        testSpecs: [
          {
            path: `.omx/plans/test-spec-${slug}.md`,
            sha1: 'b'.repeat(40),
          },
        ],
      },
      entries: [
        {
          label: 'scope',
          path: 'docs/scope.md',
          roles: ['scope'],
          tags: [],
          relationPath: [
            { tag: 'plan', target: slug },
            { tag: 'bounds', target: 'docs/scope.md' },
          ],
        },
        {
          label: 'build',
          path: 'docs/build.md',
          roles: ['build'],
          tags: [],
          relationPath: [
            { tag: 'plan', target: slug },
            { tag: 'implements', target: 'docs/build.md' },
          ],
        },
        {
          label: 'verify',
          path: 'docs/verify.md',
          roles: ['verify'],
          tags: [],
          relationPath: [
            { tag: 'plan', target: slug },
            { tag: 'verifies', target: 'docs/verify.md' },
          ],
        },
      ],
    });

    const baseline = resolveApprovedPlanBaselineForSlug(tempDir, slug);
    const detailIssues = baseline.baselineIssues.slice(1);
    assert.deepEqual(baseline.baselineIssues, [
      'Approved plan is missing a matching test spec.',
      `Approved timestamped plan requires test spec \`test-spec-20260427T153000Z-${slug}.md\`.`,
      `Found non-matching test-spec files: \`test-spec-${slug}.md\`, \`testspec-20260427T153000Z-${slug}.md\`.`,
    ]);

    const selection = readLatestPlanningArtifacts(tempDir);
    assert.equal(selection.contextPackStatus, 'missing-baseline');
    assert.deepEqual(
      selection.contextPackIssues.slice(0, baseline.baselineIssues.length),
      baseline.baselineIssues,
    );

    const hint = readApprovedExecutionLaunchHint(tempDir, 'ralph');
    assert.ok(hint);
    assert.equal(hint?.contextPackStatus, 'missing-baseline');
    assert.deepEqual(
      hint?.contextPackIssues.slice(0, baseline.baselineIssues.length),
      baseline.baselineIssues,
    );

    assert.equal(buildContextPackBasis(tempDir, slug), null);
    assert.deepEqual(describeContextPackBasisResolutionIssues(tempDir, slug), detailIssues);

    const handoff = readContextPackHandoffStatus(tempDir, absolutePackPath);
    assert.equal(handoff.handoffState, 'missing-baseline');
    assert.equal(handoff.issues[0], `Approved plan is missing a matching test spec for slug ${slug}.`);
    assert.deepEqual(handoff.issues.slice(1, 3), detailIssues);

    const validationIssues = validateContextPackManifest({
      packPath: absolutePackPath,
      expectedSlug: slug,
      repoRoot: tempDir,
      requireFreshBasis: true,
    });
    assert.ok(validationIssues.includes(
      `Approved timestamped plan requires test spec \`test-spec-20260427T153000Z-${slug}.md\`.`,
    ));
    assert.ok(validationIssues.includes(
      `Found non-matching test-spec files: \`test-spec-${slug}.md\`, \`testspec-20260427T153000Z-${slug}.md\`.`,
    ));

    await assert.rejects(
      () => contextToolMain(['sync', `.omx/context/context-20260420T000000Z-${slug}.json`], tempDir),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Could not resolve approved PRD\/test-spec basis/);
        assert.match(
          error.message,
          new RegExp(`Approved timestamped plan requires test spec \`test-spec-20260427T153000Z-${slug}\\.md\`\\.`),
        );
        assert.match(
          error.message,
          new RegExp(`Found non-matching test-spec files: \`test-spec-${slug}\\.md\`, \`testspec-20260427T153000Z-${slug}\\.md\`\\.`),
        );
        return true;
      },
    );
  });

  it('prefers the exact legacy PRD basename over case-variant duplicates for slug-based lifecycle lookups', async (t) => {
    if (!(await supportsCaseDistinctPlanArtifacts())) {
      t.skip('case-variant duplicate PRD files require a case-sensitive filesystem');
      return;
    }

    const slug = 'issue-case-duplicate';
    const exactPackPath = packPath(slug);
    const plansDir = await writePlanFiles({
      [`prd-${slug}.md`]: prdWithContextPackOutcome(
        `- pack: created \`.omx/context/context-20260420T000000Z-${slug}.json\``,
      ),
      [`test-spec-${slug}.md`]: '# Test Spec\n',
    });
    await writeRoleDocs(slug);
    writeContextPackDocument(exactPackPath, {
      schema: CONTEXT_PACK_SCHEMA,
      slug,
      entries: requiredRoles().map((role) => buildRoleEntry(slug, role)),
    }, { refreshBasis: true });

    await writeFile(join(plansDir, `PRD-${slug}.md`), '# Duplicate variant without approved outcome\n');

    const baseline = resolveApprovedPlanBaselineForSlug(tempDir, slug, { includeBasis: true });
    assert.equal(baseline.prdPath, join(plansDir, `prd-${slug}.md`));
    assert.equal(baseline.canonicalPrdPath, join(plansDir, `prd-${slug}.md`));
    assert.equal(baseline.basis?.prd.path, `.omx/plans/prd-${slug}.md`);

    assert.deepEqual(validateContextPackManifest({
      packPath: exactPackPath,
      expectedSlug: slug,
      repoRoot: tempDir,
      requireFreshBasis: true,
    }), []);

    const handoff = readContextPackHandoffStatus(tempDir, exactPackPath);
    assert.equal(handoff.prdPath, join(plansDir, `prd-${slug}.md`));
    assert.equal(handoff.outcomeState, 'single');
    assert.equal(handoff.handoffState, 'ready');

    await contextToolMain(['sync', `.omx/context/context-20260420T000000Z-${slug}.json`], tempDir);
    const syncedDocument = JSON.parse(await readFile(exactPackPath, 'utf-8')) as {
      basis?: { prd: { path: string } };
    };
    assert.equal(syncedDocument.basis?.prd.path, `.omx/plans/prd-${slug}.md`);
  });
});
