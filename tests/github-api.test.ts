import { describe, expect, it } from 'vitest';

import { findPassedRun, Octokit } from '../src/github-api';
import { IWorkflowRun } from '../src/model';

interface IApiJob {
  name: string;
  conclusion: string | null;
}

const currentRun: IWorkflowRun = {
  id: 10,
  event: 'pull_request',
  workflowId: 1,
  createdDate: new Date('2025-01-02T00:00:00Z'),
  headSha: 'current-sha',
  treeHash: 'tree',
  status: 'in_progress',
  conclusion: null,
  url: 'current-run',
};

const buildApiRun = (id: number, conclusion: string = 'success', treeHash: string = 'tree') => ({
  id,
  event: 'pull_request',
  workflow_id: 1,
  created_at: new Date(Date.UTC(2025, 0, 1) - id * 1000).toISOString(),
  head_sha: `sha${id}`,
  status: 'completed',
  conclusion,
  html_url: `run${id}`,
  head_commit: { tree_id: treeHash },
});

// NOTE(krishan711): runs are given newest first, like the API lists them
const buildOctokit = (runs: ReturnType<typeof buildApiRun>[], jobsByRun: Record<number, IApiJob[]>): Octokit => ({
  rest: { actions: { listWorkflowRuns: 'listWorkflowRuns', listJobsForWorkflowRun: 'listJobsForWorkflowRun' } },
  paginate: Object.assign(
    async (_method: string, params: { run_id: number }): Promise<IApiJob[]> => jobsByRun[params.run_id] ?? [],
    { iterator: async function* () { yield { data: runs }; } },
  ),
} as unknown as Octokit);

const find = (octokit: Octokit): Promise<IWorkflowRun | null> => findPassedRun(octokit, 'owner', 'repo', currentRun, ['tree'], new Date('2024-12-31T00:00:00Z'), 'build');

describe('findPassedRun', () => {
  it('returns the newest run where this job passed', async () => {
    const octokit = buildOctokit([buildApiRun(1, 'success', 'other-tree'), buildApiRun(2, 'failure'), buildApiRun(3), buildApiRun(4), buildApiRun(5)], {
      3: [{ name: 'build', conclusion: 'failure' }],
      4: [{ name: 'lint', conclusion: 'success' }, { name: 'build', conclusion: 'success' }],
      5: [{ name: 'build', conclusion: 'success' }],
    });
    expect((await find(octokit))?.id).toBe(4);
  });

  it('does not reuse a successful run where this job was skipped', async () => {
    const octokit = buildOctokit([buildApiRun(1)], { 1: [{ name: 'build', conclusion: 'skipped' }] });
    expect(await find(octokit)).toBeNull();
  });
});
