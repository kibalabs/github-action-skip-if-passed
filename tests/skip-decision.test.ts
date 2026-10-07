import { describe, expect, it } from 'vitest';

import { ICommit, IPathFilter, IWorkflowRun } from '../src/model';
import { decideSkip, MAX_COMMITS_TO_CHECK } from '../src/skip-decision';

const API_FILTER: IPathFilter = { type: 'paths', patterns: ['api/**'] };

const buildRun = (id: number, treeHash: string, conclusion: string | null, overrides: Partial<IWorkflowRun> = {}): IWorkflowRun => ({
  id,
  event: 'pull_request',
  workflowId: 1,
  createdDate: new Date(id * 1000),
  headSha: `sha${id}`,
  treeHash,
  status: conclusion === null ? 'in_progress' : 'completed',
  conclusion,
  url: `run${id}`,
  ...overrides,
});

// NOTE(krishan711): commits are listed newest first, each one's parent is the next in the list
const buildHistory = (commits: { treeHash: string; changedFiles: string[]; hasAllChangedFiles?: boolean }[]): ((sha: string) => Promise<ICommit>) => {
  const commitMap = new Map(commits.map((commit, index): [string, ICommit] => [`c${index}`, {
    sha: `c${index}`,
    treeHash: commit.treeHash,
    parentSha: index + 1 < commits.length ? `c${index + 1}` : null,
    changedFiles: commit.changedFiles,
    hasAllChangedFiles: commit.hasAllChangedFiles ?? true,
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

describe('decideSkip', () => {
  it('skips when the exact same files already passed', async () => {
    const decision = await decideSkip({ currentRun, olderRuns: [buildRun(1, 't0', 'success')], pathFilter: null, getCommit: buildHistory([]) });
    expect(decision.passedRun?.id).toBe(1);
  });

  it.each(['failure', 'cancelled', 'timed_out', 'skipped'])('does not count a %s run on the same files', async (conclusion: string) => {
    const decision = await decideSkip({ currentRun, olderRuns: [buildRun(1, 't0', conclusion)], pathFilter: null, getCommit: buildHistory([]) });
    expect(decision.passedRun).toBeNull();
  });

  it('does not count a run that is still going', async () => {
    const decision = await decideSkip({ currentRun, olderRuns: [buildRun(1, 't0', null)], pathFilter: null, getCommit: buildHistory([]) });
    expect(decision.passedRun).toBeNull();
  });

  it('skips when no commit since the last passing run touched the checked paths', async () => {
    const getCommit = buildHistory([
      { treeHash: 't0', changedFiles: ['app/main.ts'] },
      { treeHash: 't1', changedFiles: ['README.md'] },
      { treeHash: 't2', changedFiles: ['api/app.py'] },
    ]);
    const decision = await decideSkip({ currentRun, olderRuns: [buildRun(2, 't2', 'success')], pathFilter: API_FILTER, getCommit });
    expect(decision.passedRun?.id).toBe(2);
  });

  it('runs when a commit since the last passing run touched the checked paths', async () => {
    const getCommit = buildHistory([
      { treeHash: 't0', changedFiles: ['app/main.ts'] },
      { treeHash: 't1', changedFiles: ['api/app.py'] },
      { treeHash: 't2', changedFiles: ['api/app.py'] },
    ]);
    const decision = await decideSkip({ currentRun, olderRuns: [buildRun(2, 't2', 'success')], pathFilter: API_FILTER, getCommit });
    expect(decision.passedRun).toBeNull();
    expect(decision.reason).toContain('c1');
  });

  it('runs when the last run on the checked paths failed', async () => {
    const getCommit = buildHistory([
      { treeHash: 't0', changedFiles: ['app/main.ts'] },
      { treeHash: 't1', changedFiles: ['api/app.py'] },
    ]);
    const decision = await decideSkip({ currentRun, olderRuns: [buildRun(1, 't1', 'failure')], pathFilter: API_FILTER, getCommit });
    expect(decision.passedRun).toBeNull();
  });

  it('runs when the current commit itself touched the checked paths', async () => {
    const getCommit = buildHistory([
      { treeHash: 't0', changedFiles: ['api/app.py'] },
      { treeHash: 't1', changedFiles: ['api/app.py'] },
    ]);
    const decision = await decideSkip({ currentRun, olderRuns: [buildRun(1, 't1', 'success')], pathFilter: API_FILTER, getCommit });
    expect(decision.passedRun).toBeNull();
  });

  it('treats a commit with too many changed files to list as touching everything', async () => {
    const getCommit = buildHistory([
      { treeHash: 't0', changedFiles: ['app/main.ts'], hasAllChangedFiles: false },
      { treeHash: 't1', changedFiles: ['api/app.py'] },
    ]);
    const decision = await decideSkip({ currentRun, olderRuns: [buildRun(1, 't1', 'success')], pathFilter: API_FILTER, getCommit });
    expect(decision.passedRun).toBeNull();
  });

  it.each(['workflow_dispatch', 'schedule', 'merge_group'])('never skips %s runs', async (event: string) => {
    const decision = await decideSkip({ currentRun: { ...currentRun, event }, olderRuns: [buildRun(1, 't0', 'success')], pathFilter: null, getCommit: buildHistory([]) });
    expect(decision.passedRun).toBeNull();
  });

  it('only looks back a limited number of commits', async () => {
    const commits = Array.from({ length: MAX_COMMITS_TO_CHECK + 5 }, (_, index) => ({ treeHash: `t${index}`, changedFiles: ['README.md'] }));
    const lastTree = `t${commits.length - 1}`;
    const decision = await decideSkip({ currentRun, olderRuns: [buildRun(1, lastTree, 'success')], pathFilter: API_FILTER, getCommit: buildHistory(commits) });
    expect(decision.passedRun).toBeNull();
  });
});
