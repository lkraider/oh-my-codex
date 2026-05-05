import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface TmuxEnvSnapshot {
  TMUX?: string;
  TMUX_PANE?: string;
}

export interface TempTmuxSessionFixture {
  sessionName: string;
  serverName: string;
  windowTarget: string;
  leaderPaneId: string;
  socketPath: string;
  serverKind: 'ambient' | 'synthetic';
  env: {
    TMUX: string;
    TMUX_PANE: string;
  };
  sessionExists: (targetSessionName?: string) => boolean;
}

export interface TempTmuxSessionOptions {
  useAmbientServer?: boolean;
}

function resolveTmuxCommand(): string {
  const directCandidates = [
    '/opt/homebrew/bin/tmux',
    '/usr/local/bin/tmux',
    '/usr/bin/tmux',
    '/bin/tmux',
  ];
  for (const candidate of directCandidates) {
    if (existsSync(candidate)) return candidate;
  }

  const baselinePath = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].join(':');
  const result = spawnSync('which', ['tmux'], {
    encoding: 'utf-8',
    env: { ...process.env, PATH: baselinePath },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const resolved = (result.stdout || '').trim();
  return result.status === 0 && resolved ? resolved : 'tmux';
}

const BASELINE_PATH = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
].join(':');

export const REAL_TMUX_COMMAND = resolveTmuxCommand();

function buildTmuxEnv(
  source: NodeJS.ProcessEnv,
  { ignoreTmuxEnv = false }: { ignoreTmuxEnv?: boolean } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: BASELINE_PATH,
    HOME: source.HOME,
    USER: source.USER,
    LOGNAME: source.LOGNAME,
    SHELL: source.SHELL,
    TMPDIR: source.TMPDIR,
    TERM: source.TERM,
    LANG: source.LANG,
    LC_ALL: source.LC_ALL,
    LC_CTYPE: source.LC_CTYPE,
    LC_MESSAGES: source.LC_MESSAGES,
  };
  if (!ignoreTmuxEnv) {
    env.TMUX = source.TMUX;
    env.TMUX_PANE = source.TMUX_PANE;
  }
  return Object.fromEntries(
    Object.entries(env).filter(([, value]) => typeof value === 'string' && value.length > 0),
  );
}

function snapshotTmuxEnv(source: NodeJS.ProcessEnv = process.env): TmuxEnvSnapshot {
  return {
    TMUX: typeof source.TMUX === 'string' ? source.TMUX : undefined,
    TMUX_PANE: typeof source.TMUX_PANE === 'string' ? source.TMUX_PANE : undefined,
  };
}

function applyTmuxEnv(snapshot: TmuxEnvSnapshot): void {
  if (typeof snapshot.TMUX === 'string') process.env.TMUX = snapshot.TMUX;
  else delete process.env.TMUX;

  if (typeof snapshot.TMUX_PANE === 'string') process.env.TMUX_PANE = snapshot.TMUX_PANE;
  else delete process.env.TMUX_PANE;
}

function runTmux(
  args: string[],
  options: { ignoreTmuxEnv?: boolean; env?: NodeJS.ProcessEnv; serverName?: string } = {},
): string {
  const sourceEnv = options.env ?? process.env;
  const env = buildTmuxEnv(sourceEnv, { ignoreTmuxEnv: options.ignoreTmuxEnv });
  const argv = options.serverName ? ['-L', options.serverName, ...args] : args;
  const result = spawnSync(REAL_TMUX_COMMAND, argv, {
    encoding: 'utf-8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || '').trim() || `tmux exited ${result.status}`);
  }
  return (result.stdout || '').trim();
}

export function isRealTmuxAvailable(): boolean {
  try {
    runTmux(['-V'], { ignoreTmuxEnv: true });
    return true;
  } catch {
    return false;
  }
}

export function tmuxSessionExists(sessionName: string, serverName?: string): boolean {
  try {
    runTmux(['has-session', '-t', sessionName], {
      ignoreTmuxEnv: true,
      serverName,
    });
    return true;
  } catch {
    return false;
  }
}

function uniqueTmuxIdentifier(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function withTempTmuxSession<T>(
  optionsOrFn: TempTmuxSessionOptions | ((fixture: TempTmuxSessionFixture) => Promise<T> | T),
  maybeFn?: (fixture: TempTmuxSessionFixture) => Promise<T> | T,
): Promise<T> {
  if (!isRealTmuxAvailable()) {
    throw new Error('tmux is not available');
  }

  const options = typeof optionsOrFn === 'function' ? {} : optionsOrFn;
  const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn;
  if (!fn) {
    throw new Error('withTempTmuxSession requires a callback');
  }

  const previousEnv = snapshotTmuxEnv(process.env);
  const fixtureCwd = await mkdtemp(join(tmpdir(), 'omx-tmux-fixture-'));
  const sessionName = uniqueTmuxIdentifier('omx-test');
  const serverName = options.useAmbientServer ? '' : uniqueTmuxIdentifier('omx-fixture');
  const serverKind: TempTmuxSessionFixture['serverKind'] = options.useAmbientServer ? 'ambient' : 'synthetic';
  const tmuxOptions = { ignoreTmuxEnv: true, serverName: serverName || undefined } as const;

  const created = runTmux([
    'new-session',
    '-d',
    '-P',
    '-F',
    '#{session_name}:#{window_index} #{pane_id}',
    '-s',
    sessionName,
    '-c',
    fixtureCwd,
    'sleep 300',
  ], tmuxOptions);
  const [windowTarget = '', leaderPaneId = ''] = created.split(/\s+/, 2);
  if (windowTarget === '' || leaderPaneId === '') {
    try {
      if (serverKind === 'synthetic') {
        runTmux(['kill-server'], tmuxOptions);
      } else {
        runTmux(['kill-session', '-t', sessionName], tmuxOptions);
      }
    } catch {}
    await rm(fixtureCwd, { recursive: true, force: true });
    throw new Error(`failed to create temporary tmux fixture: ${created}`);
  }

  const socketPath = runTmux(['display-message', '-p', '-t', leaderPaneId, '#{socket_path}'], tmuxOptions);
  process.env.TMUX = `${socketPath},${process.pid},0`;
  process.env.TMUX_PANE = leaderPaneId;

  const fixture: TempTmuxSessionFixture = {
    sessionName,
    serverName,
    windowTarget,
    leaderPaneId,
    socketPath,
    serverKind,
    env: {
      TMUX: process.env.TMUX,
      TMUX_PANE: leaderPaneId,
    },
    sessionExists: (targetSessionName = sessionName) => tmuxSessionExists(targetSessionName, serverName || undefined),
  };

  try {
    return await fn(fixture);
  } finally {
    try {
      if (serverKind === 'synthetic') {
        runTmux(['kill-server'], tmuxOptions);
      } else {
        runTmux(['kill-session', '-t', sessionName], tmuxOptions);
      }
    } catch {}
    applyTmuxEnv(previousEnv);
    await rm(fixtureCwd, { recursive: true, force: true });
  }
}
