export const SKIP_ENVIRONMENT_VARIABLE = 'CHECKS_ALREADY_PASSED';

export const SKIPPABLE_EVENTS: readonly string[] = ['push', 'pull_request'];

export interface IWorkflowRun {
  id: number;
  event: string;
  workflowId: number;
  createdDate: Date;
  headSha: string;
  treeHash: string | null;
  status: string | null;
  conclusion: string | null;
  url: string;
}

export interface ICommit {
  sha: string;
  treeHash: string;
  parentSha: string | null;
  changedFiles: string[];
  hasAllChangedFiles: boolean;
  committedDate: Date;
}

export type PathFilterType = 'paths' | 'paths-ignore';

export interface IPathFilter {
  type: PathFilterType;
  patterns: string[];
}

export interface ISkipDecision {
  passedRun: IWorkflowRun | null;
  reason: string;
}
