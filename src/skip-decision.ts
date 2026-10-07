import { ICommit, IPathFilter, ISkipDecision, IWorkflowRun, NEVER_SKIPPED_EVENTS } from './model';
import { isRelevantChange } from './path-filter';

export const MAX_COMMITS_TO_CHECK = 50;
// NOTE(krishan711): a run can't have checked files from before their commit existed, the margin allows for clock differences
const RUN_SEARCH_MARGIN_MS = 60 * 60 * 1000;

export interface ISkipDecisionInput {
  currentRun: IWorkflowRun;
  pathFilter: IPathFilter | null;
  getCommit: (sha: string) => Promise<ICommit>;
  findPassedRun: (treeHashes: string[], sinceDate: Date) => Promise<IWorkflowRun | null>;
}

export const isEarlierPassedRun = (run: IWorkflowRun, currentRun: IWorkflowRun, treeHashes: string[]): boolean => {
  return run.id !== currentRun.id
    && run.createdDate < currentRun.createdDate
    && run.treeHash !== null && treeHashes.includes(run.treeHash)
    && run.status === 'completed' && run.conclusion === 'success';
};

// NOTE(krishan711): walks back from the current commit while commits don't change the checked paths, a passing run on any of these commits' files means the current ones pass too
const collectCandidateCommits = async (getCommit: (sha: string) => Promise<ICommit>, sha: string | null, pathFilter: IPathFilter | null, collectedCommits: ICommit[]): Promise<ICommit[]> => {
  if (!sha || collectedCommits.length > MAX_COMMITS_TO_CHECK) {
    return collectedCommits;
  }
  const commit = await getCommit(sha);
  const commits = [...collectedCommits, commit];
  // NOTE(krishan711): GitHub only lists the first 300 changed files of a commit, so a commit with more counts as changing everything
  if (!pathFilter || !commit.hasAllChangedFiles || isRelevantChange(commit.changedFiles, pathFilter)) {
    return commits;
  }
  return collectCandidateCommits(getCommit, commit.parentSha, pathFilter, commits);
};

export const decideSkip = async (input: ISkipDecisionInput): Promise<ISkipDecision> => {
  const { currentRun, pathFilter, getCommit, findPassedRun } = input;
  if (NEVER_SKIPPED_EVENTS.includes(currentRun.event)) {
    return { passedRun: null, reason: `${currentRun.event} runs are never skipped` };
  }
  if (!currentRun.treeHash) {
    return { passedRun: null, reason: 'the files of the current commit could not be found' };
  }
  const candidateCommits = await collectCandidateCommits(getCommit, currentRun.headSha, pathFilter, []);
  const oldestCommitTime = Math.min(...candidateCommits.map((commit: ICommit): number => commit.committedDate.getTime()));
  const passedRun = await findPassedRun(candidateCommits.map((commit: ICommit): string => commit.treeHash), new Date(oldestCommitTime - RUN_SEARCH_MARGIN_MS));
  if (passedRun) {
    return { passedRun, reason: passedRun.treeHash === currentRun.treeHash ? `the exact same files already passed in ${passedRun.url}` : `nothing this job checks has changed since ${passedRun.url} passed` };
  }
  if (!pathFilter) {
    return { passedRun: null, reason: 'no earlier run passed on the exact same files, and there is no paths filter to look further back with' };
  }
  const lastCommit = candidateCommits[candidateCommits.length - 1];
  return { passedRun: null, reason: `no run passed since commit ${lastCommit.sha.slice(0, 7)}, which changed files this job checks` };
};
