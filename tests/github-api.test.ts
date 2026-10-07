import { describe, expect, it, vi } from 'vitest';

import { findPassedRun, getCurrentJobName, Octokit } from '../src/github-api';
import { IWorkflowRun } from '../src/model';

interface IApiRun {
  id: number;
  event: string;
  run_attempt?: number;
  created_at: string;
  head_sha: string;
  status: string | null;
  conclusion: string | null;
  html_url: string;
  head_commit: { tree_id: string } | null;
}

interface IApiJob {
  name: string;
  runner_name: string | null;
  status: string;
  conclusion: string | null;
}

const currentRun: IWorkflowRun = {
  id: 10,
  event: 'pull_request',
  workflowId: 1,
  runAttempt: 4,
  createdDate: new Date('2025-01-02T00:00:00Z'),
  headSha: 'current-sha',
  treeHash: 'tree',
  status: 'in_progress',
  conclusion: null,
  url: 'current-run',
};

const buildApiRun = (id: number, overrides: Partial<IApiRun> = {}): IApiRun => ({
  id,
  event: 'pull_request',
  workflow_id: 1,
  run_attempt: 1,
  created_at: `2025-01-01T00:00:${String(id).padStart(2, '0')}Z`,
  head_sha: `sha${id}`,
  status: 'completed',
  conclusion: 'success',
  html_url: `run${id}`,
  head_commit: { tree_id: 'tree' },
  ...overrides,
});

const getRunId = (params: unknown): number => {
  if (!params || typeof params !== 'object' || !('run_id' in params) || typeof params.run_id !== 'number') {
    throw new Error('workflow job request has no run_id');
  }
  return params.run_id;
};

const createOctokit = (runs: IApiRun[], jobsByRun: Record<number, IApiJob[]>) => {
  const listWorkflowRuns = vi.fn(async (_params: unknown) => ({ data: runs }));
  const listJobsForWorkflowRunAttempt = vi.fn(async (params: unknown) => {
    const runId = getRunId(params);
    return { data: jobsByRun[runId] ?? [] };
  });
  const iterator = <T>(method: (params: unknown) => Promise<T>, params: unknown): AsyncIterableIterator<T> => (async function* (): AsyncGenerator<T> {
    yield await method(params);
  })();
  const octokit = {
    rest: { actions: { listWorkflowRuns, listJobsForWorkflowRunAttempt } },
    paginate: { iterator },
  } as unknown as Octokit;
  return { octokit, listJobsForWorkflowRunAttempt, listWorkflowRuns };
};

describe('findPassedRun', () => {
  it('requires the matching job to have succeeded and stops at the first passing job', async () => {
    const { octokit, listJobsForWorkflowRunAttempt, listWorkflowRuns } = createOctokit([
      buildApiRun(1, { head_commit: { tree_id: 'other-tree' } }),
      buildApiRun(2, { conclusion: 'failure' }),
      buildApiRun(3, { run_attempt: 2 }),
      buildApiRun(4, { run_attempt: 7 }),
      buildApiRun(5),
    ], {
      3: [{ name: 'build', runner_name: null, status: 'completed', conclusion: 'failure' }],
      4: [{ name: 'build', runner_name: null, status: 'completed', conclusion: 'success' }],
      5: [{ name: 'build', runner_name: null, status: 'completed', conclusion: 'success' }],
    });

    const passedRun = await findPassedRun(octokit, 'owner', 'repo', currentRun, ['tree'], new Date('2024-12-31T00:00:00Z'), 'build');

    expect(passedRun?.id).toBe(4);
    expect(listWorkflowRuns.mock.calls[0][0]).toMatchObject({ exclude_pull_requests: false });
    expect(listJobsForWorkflowRunAttempt.mock.calls.map(([params]) => getRunId(params))).toEqual([3, 4]);
    expect(listJobsForWorkflowRunAttempt.mock.calls[1][0]).toMatchObject({ attempt_number: 7 });
  });

  it('does not reuse a workflow run when the matching job was skipped', async () => {
    const { octokit } = createOctokit([buildApiRun(1)], {
      1: [{ name: 'build', runner_name: null, status: 'completed', conclusion: 'skipped' }],
    });

    await expect(findPassedRun(octokit, 'owner', 'repo', currentRun, ['tree'], new Date('2024-12-31T00:00:00Z'), 'build')).resolves.toBeNull();
  });

  it('does not reuse a run when its attempt is unavailable', async () => {
    const { octokit, listJobsForWorkflowRunAttempt } = createOctokit([buildApiRun(1, { run_attempt: undefined })], {});

    await expect(findPassedRun(octokit, 'owner', 'repo', currentRun, ['tree'], new Date('2024-12-31T00:00:00Z'), 'build')).resolves.toBeNull();
    expect(listJobsForWorkflowRunAttempt).not.toHaveBeenCalled();
  });
});

describe('getCurrentJobName', () => {
  it('identifies the in-progress job on the current runner and attempt', async () => {
    const { octokit, listJobsForWorkflowRunAttempt } = createOctokit([], {
      [currentRun.id]: [
        { name: 'other-runner', runner_name: 'runner-2', status: 'in_progress', conclusion: null },
        { name: 'completed-job', runner_name: 'runner-1', status: 'completed', conclusion: 'success' },
        { name: 'build', runner_name: 'runner-1', status: 'in_progress', conclusion: null },
      ],
    });

    await expect(getCurrentJobName(octokit, 'owner', 'repo', currentRun, 4, 'runner-1')).resolves.toBe('build');
    expect(listJobsForWorkflowRunAttempt.mock.calls[0][0]).toMatchObject({ run_id: currentRun.id, attempt_number: 4 });
  });
});
