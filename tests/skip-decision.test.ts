import { describe, expect, it } from 'vitest';

import { ICommit, IPathFilter, ISkipDecision, IWorkflowRun } from '../src/model';
import { decideSkip, isEarlierPassedRun, MAX_COMMITS_TO_CHECK } from '../src/skip-decision';

const API_FILTER: IPathFilter = { type: 'paths', patterns: ['api/**'] };
const HOUR_MS = 60 * 60 * 1000;

const buildRun = (id: number, treeHash: string, conclusion: string | null, overrides: Partial<IWorkflowRun> = {}): IWorkflowRun => ({
  id,
  event: 'pull_request',
  workflowId: 1,
  runAttempt: 1,
  createdDate: new Date(id * HOUR_MS),
  headSha: `sha${id}`,
  treeHash,
  status: conclusion === null ? 'in_progress' : 'completed',
  conclusion,
  url: `run${id}`,
  ...overrides,
});

interface ITestCommit {
  treeHash: string;
  changedFiles: string[];
  hasAllChangedFiles?: boolean;
  committedHour?: number;
}

// NOTE(krishan711): commits are listed newest first, each one's parent is the next in the list
const buildHistory = (commits: ITestCommit[]): ((sha: string) => Promise<ICommit>) => {
  const commitMap = new Map(commits.map((commit: ITestCommit, index: number): [string, ICommit] => [`c${index}`, {
    sha: `c${index}`,
    treeHash: commit.treeHash,
    parentSha: index + 1 < commits.length ? `c${index + 1}` : null,
    changedFiles: commit.changedFiles,
    hasAllChangedFiles: commit.hasAllChangedFiles ?? true,
    committedDate: new Date((commit.committedHour ?? 5) * HOUR_MS),
  }]));
  return async (sha: string): Promise<ICommit> => {
    const commit = commitMap.get(sha);
    if (!commit) {
      throw new Error(`unknown commit ${sha}`);
    }
    return commit;
  };
};

const currentRun = buildRun(10, 't0', null, { headSha: 'c0' });
const searches: { treeHashes: string[]; sinceDate: Date }[] = [];

const makeDecision = async (commits: ITestCommit[], olderRuns: IWorkflowRun[], pathFilter: IPathFilter | null, run: IWorkflowRun = currentRun, currentJobName: string | null = 'api-check'): Promise<ISkipDecision> => {
  searches.length = 0;
  return decideSkip({
    currentRun: run,
    pathFilter,
    getCurrentJobName: async (): Promise<string | null> => currentJobName,
    getCommit: buildHistory(commits),
    findPassedRun: async (treeHashes: string[], sinceDate: Date, _jobName: string): Promise<IWorkflowRun | null> => {
      searches.push({ treeHashes, sinceDate });
      return olderRuns.find((olderRun: IWorkflowRun): boolean => isEarlierPassedRun(olderRun, run, treeHashes)) ?? null;
    },
  });
};

const decide = async (commits: ITestCommit[], olderRuns: IWorkflowRun[], pathFilter: IPathFilter | null, run: IWorkflowRun = currentRun): Promise<IWorkflowRun | null> => (await makeDecision(commits, olderRuns, pathFilter, run)).passedRun;

describe('decideSkip', () => {
  it('skips when the exact same files already passed', async () => {
    expect((await decide([{ treeHash: 't0', changedFiles: [] }], [buildRun(1, 't0', 'success')], null))?.id).toBe(1);
  });

  it.each(['failure', 'cancelled', 'timed_out', 'skipped'])('does not count a %s run on the same files', async (conclusion: string) => {
    expect(await decide([{ treeHash: 't0', changedFiles: [] }], [buildRun(1, 't0', conclusion)], null)).toBeNull();
  });

  it('does not count a run that is still going', async () => {
    expect(await decide([{ treeHash: 't0', changedFiles: [] }], [buildRun(1, 't0', null)], null)).toBeNull();
  });

  it('does not count runs created after the current one', async () => {
    expect(await decide([{ treeHash: 't0', changedFiles: [] }], [buildRun(11, 't0', 'success')], null)).toBeNull();
  });

  it('only looks at the current files without a paths filter', async () => {
    const commits = [{ treeHash: 't0', changedFiles: ['README.md'] }, { treeHash: 't1', changedFiles: ['api/app.py'] }];
    expect(await decide(commits, [buildRun(1, 't1', 'success')], null)).toBeNull();
    expect(searches[0].treeHashes).toEqual(['t0']);
  });

  it('skips when no commit since the last passing run touched the checked paths', async () => {
    const commits = [
      { treeHash: 't0', changedFiles: ['app/main.ts'] },
      { treeHash: 't1', changedFiles: ['README.md'] },
      { treeHash: 't2', changedFiles: ['api/app.py'] },
    ];
    expect((await decide(commits, [buildRun(2, 't2', 'success')], API_FILTER))?.id).toBe(2);
    expect(searches[0].treeHashes).toEqual(['t0', 't1', 't2']);
  });

  it('runs when a commit since the last passing run touched the checked paths', async () => {
    const commits = [
      { treeHash: 't0', changedFiles: ['app/main.ts'] },
      { treeHash: 't1', changedFiles: ['api/app.py'] },
      { treeHash: 't2', changedFiles: ['api/app.py'] },
    ];
    expect(await decide(commits, [buildRun(2, 't2', 'success')], API_FILTER)).toBeNull();
    expect(searches[0].treeHashes).toEqual(['t0', 't1']);
  });

  it('runs when the last run on the checked paths failed', async () => {
    const commits = [{ treeHash: 't0', changedFiles: ['app/main.ts'] }, { treeHash: 't1', changedFiles: ['api/app.py'] }];
    expect(await decide(commits, [buildRun(1, 't1', 'failure')], API_FILTER)).toBeNull();
  });

  it('runs when the current commit itself touched the checked paths', async () => {
    const commits = [{ treeHash: 't0', changedFiles: ['api/app.py'] }, { treeHash: 't1', changedFiles: ['api/app.py'] }];
    expect(await decide(commits, [buildRun(1, 't1', 'success')], API_FILTER)).toBeNull();
    expect(searches[0].treeHashes).toEqual(['t0']);
  });

  it('treats a commit with too many changed files to list as touching everything', async () => {
    const commits = [{ treeHash: 't0', changedFiles: ['app/main.ts'], hasAllChangedFiles: false }, { treeHash: 't1', changedFiles: ['api/app.py'] }];
    expect(await decide(commits, [buildRun(1, 't1', 'success')], API_FILTER)).toBeNull();
  });

  it('searches runs from an hour before the oldest commit it would accept', async () => {
    const commits = [
      { treeHash: 't0', changedFiles: ['README.md'], committedHour: 9 },
      { treeHash: 't1', changedFiles: ['api/app.py'], committedHour: 7 },
    ];
    await decide(commits, [], API_FILTER);
    expect(searches[0].sinceDate).toEqual(new Date(6 * HOUR_MS));
  });

  it('does not reuse a passed run from a different event', async () => {
    const pushRun = buildRun(1, 't0', 'success', { event: 'push' });
    expect(await decide([{ treeHash: 't0', changedFiles: [] }], [pushRun], null)).toBeNull();
  });

  it('allows push and pull_request runs to skip', async () => {
    expect((await decide([{ treeHash: 't0', changedFiles: [] }], [buildRun(1, 't0', 'success')], null))?.id).toBe(1);
    const pushRun = buildRun(1, 't0', 'success', { event: 'push' });
    expect((await decide([{ treeHash: 't0', changedFiles: [] }], [pushRun], null, { ...currentRun, event: 'push' }))?.id).toBe(1);
  });

  it.each(['workflow_dispatch', 'schedule', 'merge_group', 'issues', 'issue_comment'])('%s runs are never skipped', async (event: string) => {
    const decision = await makeDecision([{ treeHash: 't0', changedFiles: [] }], [buildRun(1, 't0', 'success')], null, { ...currentRun, event });
    expect(decision).toEqual({ passedRun: null, reason: `${event} runs are never skipped` });
    expect(searches).toEqual([]);
  });

  it('does not skip when the current job cannot be identified', async () => {
    const decision = await makeDecision([{ treeHash: 't0', changedFiles: [] }], [buildRun(1, 't0', 'success')], null, currentRun, null);
    expect(decision.passedRun).toBeNull();
    expect(searches).toEqual([]);
  });

  it('only looks back a limited number of commits', async () => {
    const commits = Array.from({ length: MAX_COMMITS_TO_CHECK + 5 }, (_, index: number): ITestCommit => ({ treeHash: `t${index}`, changedFiles: ['README.md'] }));
    expect(await decide(commits, [buildRun(1, `t${commits.length - 1}`, 'success')], API_FILTER)).toBeNull();
  });
});
