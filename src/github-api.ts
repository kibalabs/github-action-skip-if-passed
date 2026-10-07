import { GitHub } from '@actions/github/lib/utils';

import { ICommit, IWorkflowRun } from './model';
import { isEarlierPassedRun } from './skip-decision';

export type Octokit = InstanceType<typeof GitHub>;

const MAX_RUNS_TO_CHECK = 500;
// NOTE(krishan711): small pages because a run listing is large (about 15KB per run), most searches end on the first page
const RUNS_PER_PAGE = 30;
// NOTE(krishan711): the commits API lists at most this many changed files for a single commit
const MAX_LISTED_COMMIT_FILES = 300;

interface IApiWorkflowRun {
  id: number;
  event: string;
  workflow_id: number;
  run_attempt?: number;
  created_at: string;
  head_sha: string;
  status: string | null;
  conclusion: string | null;
  html_url: string;
  head_commit?: { tree_id: string } | null;
}

const buildWorkflowRun = (run: IApiWorkflowRun): IWorkflowRun => ({
  id: run.id,
  event: run.event,
  workflowId: run.workflow_id,
  runAttempt: run.run_attempt ?? null,
  createdDate: new Date(run.created_at),
  headSha: run.head_sha,
  treeHash: run.head_commit?.tree_id ?? null,
  status: run.status,
  conclusion: run.conclusion,
  url: run.html_url,
});

export const getWorkflowRun = async (octokit: Octokit, owner: string, repo: string, runId: number): Promise<IWorkflowRun> => {
  const response = await octokit.rest.actions.getWorkflowRun({ owner, repo, run_id: runId });
  return buildWorkflowRun(response.data);
};

export const getCurrentJobName = async (octokit: Octokit, owner: string, repo: string, currentRun: IWorkflowRun, runAttempt: number, runnerName: string | undefined): Promise<string | null> => {
  if (!runnerName) {
    return null;
  }
  for await (const response of octokit.paginate.iterator(octokit.rest.actions.listJobsForWorkflowRunAttempt, { owner, repo, run_id: currentRun.id, attempt_number: runAttempt, per_page: 100 })) {
    const job = response.data.find((candidate) => candidate.runner_name === runnerName && candidate.status === 'in_progress');
    if (job) {
      return job.name;
    }
  }
  return null;
};

const hasPassedJob = async (octokit: Octokit, owner: string, repo: string, run: IWorkflowRun, jobName: string): Promise<boolean> => {
  if (run.runAttempt === null) {
    return false;
  }
  for await (const response of octokit.paginate.iterator(octokit.rest.actions.listJobsForWorkflowRunAttempt, { owner, repo, run_id: run.id, attempt_number: run.runAttempt, per_page: 100 })) {
    if (response.data.some((job) => job.name === jobName && job.conclusion === 'success')) {
      return true;
    }
  }
  return false;
};

// NOTE(krishan711): runs are listed newest first, so the search stops at the first run whose matching job passed or once runs are older than the files being looked for
export const findPassedRun = async (octokit: Octokit, owner: string, repo: string, currentRun: IWorkflowRun, treeHashes: string[], sinceDate: Date, jobName: string): Promise<IWorkflowRun | null> => {
  const runPages = octokit.paginate.iterator(octokit.rest.actions.listWorkflowRuns, { owner, repo, workflow_id: currentRun.workflowId, per_page: RUNS_PER_PAGE, exclude_pull_requests: false })[Symbol.asyncIterator]();
  const findInNextPage = async (checkedRunCount: number): Promise<IWorkflowRun | null> => {
    const page = await runPages.next();
    if (page.done) {
      return null;
    }
    const runs = page.value.data.map(buildWorkflowRun);
    const passedRun = await runs.reduce<Promise<IWorkflowRun | null>>(
      (previousPassedRun, run) => previousPassedRun.then((foundRun: IWorkflowRun | null) => {
        if (foundRun || !isEarlierPassedRun(run, currentRun, treeHashes)) {
          return foundRun;
        }
        return hasPassedJob(octokit, owner, repo, run, jobName).then((jobPassed: boolean): IWorkflowRun | null => jobPassed ? run : null);
      }),
      Promise.resolve(null),
    );
    if (passedRun) {
      return passedRun;
    }
    const newCheckedRunCount = checkedRunCount + runs.length;
    const oldestRun = runs[runs.length - 1];
    if (!oldestRun || oldestRun.createdDate < sinceDate || newCheckedRunCount >= MAX_RUNS_TO_CHECK) {
      return null;
    }
    return findInNextPage(newCheckedRunCount);
  };
  return findInNextPage(0);
};

export const getCommit = async (octokit: Octokit, owner: string, repo: string, sha: string): Promise<ICommit> => {
  const response = await octokit.rest.repos.getCommit({ owner, repo, ref: sha, per_page: MAX_LISTED_COMMIT_FILES });
  const files = response.data.files ?? [];
  return {
    sha: response.data.sha,
    treeHash: response.data.commit.tree.sha,
    parentSha: response.data.parents[0]?.sha ?? null,
    changedFiles: files.map((file): string => file.filename),
    hasAllChangedFiles: files.length < MAX_LISTED_COMMIT_FILES,
    committedDate: new Date(response.data.commit.committer?.date ?? response.data.commit.author?.date ?? 0),
  };
};

export const getFileContent = async (octokit: Octokit, owner: string, repo: string, path: string, ref: string): Promise<string> => {
  const response = await octokit.rest.repos.getContent({ owner, repo, path, ref });
  if (Array.isArray(response.data) || response.data.type !== 'file') {
    throw new Error(`${path} is not a file`);
  }
  return Buffer.from(response.data.content, 'base64').toString('utf8');
};
