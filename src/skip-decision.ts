import { ICommit, IPathFilter, ISkipDecision, IWorkflowRun, NEVER_SKIPPED_EVENTS } from './model';
import { isRelevantChange } from './path-filter';

export const MAX_COMMITS_TO_CHECK = 50;

export interface ISkipDecisionInput {
  currentRun: IWorkflowRun;
  olderRuns: IWorkflowRun[];
  pathFilter: IPathFilter | null;
  getCommit: (sha: string) => Promise<ICommit>;
}

export const decideSkip = async (input: ISkipDecisionInput): Promise<ISkipDecision> => {
  const { currentRun, olderRuns, pathFilter, getCommit } = input;
  if (NEVER_SKIPPED_EVENTS.includes(currentRun.event)) {
    return { passedRun: null, reason: `${currentRun.event} runs are never skipped` };
  }
  if (!currentRun.treeHash) {
    return { passedRun: null, reason: 'the files of the current commit could not be found' };
  }
  const findPassedRun = (treeHash: string): IWorkflowRun | null => {
    return olderRuns.find((run: IWorkflowRun): boolean => run.treeHash === treeHash && run.status === 'completed' && run.conclusion === 'success') ?? null;
  };
  const identicalRun = findPassedRun(currentRun.treeHash);
  if (identicalRun) {
    return { passedRun: identicalRun, reason: `the exact same files already passed in ${identicalRun.url}` };
  }
  if (!pathFilter) {
    return { passedRun: null, reason: 'no earlier run passed on the exact same files, and there is no paths filter to look further back with' };
  }
  const checkCommit = async (sha: string | null, distance: number): Promise<ISkipDecision> => {
    if (!sha || distance > MAX_COMMITS_TO_CHECK) {
      return { passedRun: null, reason: `no passing run found in the last ${MAX_COMMITS_TO_CHECK} commits` };
    }
    const commit = await getCommit(sha);
    const passedRun = distance > 0 ? findPassedRun(commit.treeHash) : null;
    if (passedRun) {
      return { passedRun, reason: `nothing this job checks has changed since ${passedRun.url} passed` };
    }
    // NOTE(krishan711): GitHub only lists the first 300 changed files of a commit, so a commit with more counts as changing everything
    if (!commit.hasAllChangedFiles || isRelevantChange(commit.changedFiles, pathFilter)) {
      return { passedRun: null, reason: `commit ${commit.sha.slice(0, 7)} changed files this job checks and has no passing run` };
    }
    return checkCommit(commit.parentSha, distance + 1);
  };
  return checkCommit(currentRun.headSha, 0);
};
