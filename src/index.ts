import { exportVariable, getInput, getMultilineInput, summary as jobSummary, info as logInfo, notice, setOutput, warning } from '@actions/core';
import { getOctokit, context as githubContext } from '@actions/github';

import { copyCheckRuns } from './copy-checks';
import { findPassedRun, getCommit, getCurrentJobName, getFileContent, getWorkflowRun, Octokit } from './github-api';
import { IPathFilter, SKIP_ENVIRONMENT_VARIABLE } from './model';
import { readTriggerPathFilter } from './path-filter';
import { decideSkip } from './skip-decision';

const getPathFilter = async (octokit: Octokit, owner: string, repo: string): Promise<IPathFilter | null> => {
  const pathsInput = getMultilineInput('paths', { required: false });
  if (pathsInput.length > 0) {
    return { type: 'paths', patterns: pathsInput };
  }
  // NOTE(krishan711): GITHUB_WORKFLOW_REF looks like owner/repo/.github/workflows/file.yml@refs/heads/branch
  const workflowRef = process.env.GITHUB_WORKFLOW_REF ?? '';
  const workflowPath = workflowRef.slice(`${owner}/${repo}/`.length).split('@')[0];
  const workflowSha = process.env.GITHUB_WORKFLOW_SHA || githubContext.sha;
  const workflowContent = await getFileContent(octokit, owner, repo, workflowPath, workflowSha);
  return readTriggerPathFilter(workflowContent, githubContext.eventName);
};

const run = async (): Promise<void> => {
  try {
    const octokit = getOctokit(getInput('github-token', { required: true }));
    const { owner, repo } = githubContext.repo;
    const pathFilter = await getPathFilter(octokit, owner, repo);
    logInfo(pathFilter ? `Checking ${pathFilter.type}: ${pathFilter.patterns.join(', ')}` : 'No paths filter, only skipping when the exact same files passed');
    const currentRun = await getWorkflowRun(octokit, owner, repo, githubContext.runId);
    const decision = await decideSkip({
      currentRun,
      pathFilter,
      getCurrentJobName: () => getCurrentJobName(octokit, owner, repo, currentRun.id, process.env.RUNNER_NAME),
      getCommit: (sha: string) => getCommit(octokit, owner, repo, sha),
      findPassedRun: (treeHashes: string[], sinceDate: Date, jobName: string) => findPassedRun(octokit, owner, repo, currentRun, treeHashes, sinceDate, jobName),
    });
    setOutput('reason', decision.reason);
    if (!decision.passedRun) {
      logInfo(`Not skipping: ${decision.reason}`);
      setOutput('should-skip', 'false');
      return;
    }
    notice(`Skipping: ${decision.reason}`, { title: 'Skipped' });
    setOutput('passed-run-url', decision.passedRun.url);
    let copiedNames: string[] = [];
    try {
      copiedNames = await copyCheckRuns(octokit, owner, repo, decision.passedRun, currentRun);
    } catch (error) {
      warning(`Could not copy the checks of the passed run: ${error instanceof Error ? error.message : String(error)}`, { title: 'Checks not copied' });
    }
    await jobSummary.addRaw(`Skipped: ${decision.reason}.${copiedNames.length > 0 ? ` Copied checks: ${copiedNames.join(', ')}.` : ''}`, true).write();
    exportVariable(SKIP_ENVIRONMENT_VARIABLE, 'true');
    setOutput('should-skip', 'true');
  } catch (error) {
    // NOTE(krishan711): when the history can't be read the job runs as normal, a needless run is better than a wrongly skipped one
    warning(`Could not check earlier runs, so not skipping: ${error instanceof Error ? error.message : String(error)}`, { title: 'Skip check failed' });
    setOutput('should-skip', 'false');
  }
};

run();
