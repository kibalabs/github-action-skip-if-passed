import { info as logInfo } from '@actions/core';

import { Octokit } from './github-api';
import { IWorkflowRun } from './model';

const MAX_ANNOTATIONS_PER_REQUEST = 50;
const MAX_OUTPUT_LENGTH = 65535;

type CheckConclusion = 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | 'stale';

interface ICheckAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  start_column?: number;
  end_column?: number;
  annotation_level: 'notice' | 'warning' | 'failure';
  message: string;
  title?: string;
  raw_details?: string;
}

const listAnnotations = async (octokit: Octokit, owner: string, repo: string, checkRunId: number): Promise<ICheckAnnotation[]> => {
  const annotations = await octokit.paginate(octokit.rest.checks.listAnnotations, { owner, repo, check_run_id: checkRunId, per_page: 100 });
  return annotations.map((annotation): ICheckAnnotation => ({
    path: annotation.path,
    start_line: annotation.start_line,
    end_line: annotation.end_line,
    ...(annotation.start_column != null ? { start_column: annotation.start_column } : {}),
    ...(annotation.end_column != null ? { end_column: annotation.end_column } : {}),
    annotation_level: (annotation.annotation_level ?? 'notice') as ICheckAnnotation['annotation_level'],
    message: annotation.message ?? '',
    ...(annotation.title ? { title: annotation.title } : {}),
    ...(annotation.raw_details ? { raw_details: annotation.raw_details } : {}),
  }));
};

type ApiCheckRun = Awaited<ReturnType<Octokit['rest']['checks']['get']>>['data'];

const copyCheckRun = async (octokit: Octokit, owner: string, repo: string, checkRun: ApiCheckRun, passedRun: IWorkflowRun, currentRun: IWorkflowRun): Promise<void> => {
  const annotations = await listAnnotations(octokit, owner, repo, checkRun.id);
  const annotationBatches: ICheckAnnotation[][] = [];
  for (let index = 0; index < annotations.length; index += MAX_ANNOTATIONS_PER_REQUEST) {
    annotationBatches.push(annotations.slice(index, index + MAX_ANNOTATIONS_PER_REQUEST));
  }
  const [firstAnnotations = [], ...remainingAnnotationBatches] = annotationBatches;
  const title = checkRun.output.title ?? checkRun.name;
  const summary = `Copied from ${passedRun.url}: these files already passed there, so this run skipped them.\n\n${checkRun.output.summary ?? ''}`.slice(0, MAX_OUTPUT_LENGTH);
  const text = checkRun.output.text ? checkRun.output.text.slice(0, MAX_OUTPUT_LENGTH) : undefined;
  const createResponse = await octokit.rest.checks.create({
    owner,
    repo,
    name: checkRun.name,
    head_sha: currentRun.headSha,
    external_id: String(currentRun.id),
    status: 'completed',
    conclusion: checkRun.conclusion as CheckConclusion,
    ...(checkRun.details_url ? { details_url: checkRun.details_url } : {}),
    output: { title, summary, text, annotations: firstAnnotations },
  });
  // NOTE(krishan711): each update appends its annotations to the check, so batches go one after another
  await remainingAnnotationBatches.reduce(async (previousUpdate: Promise<void>, batchAnnotations: ICheckAnnotation[]): Promise<void> => {
    await previousUpdate;
    await octokit.rest.checks.update({ owner, repo, check_run_id: createResponse.data.id, output: { title, summary, annotations: batchAnnotations } });
  }, Promise.resolve());
  logInfo(`Copied check '${checkRun.name}' (${checkRun.conclusion}, ${annotations.length} annotations)`);
};

// NOTE(krishan711): check runs that set external_id to their workflow run's id are treated as belonging to that run, so they can follow it onto commits it lets skip
export const copyCheckRuns = async (octokit: Octokit, owner: string, repo: string, passedRun: IWorkflowRun, currentRun: IWorkflowRun): Promise<string[]> => {
  const checkRuns = await octokit.paginate(octokit.rest.checks.listForRef, { owner, repo, ref: passedRun.headSha, per_page: 100 });
  const passedRunCheckRuns = checkRuns.filter((checkRun): boolean => checkRun.external_id === String(passedRun.id) && checkRun.status === 'completed' && checkRun.conclusion !== null);
  await passedRunCheckRuns.reduce(async (previousCopy: Promise<void>, checkRun: ApiCheckRun): Promise<void> => {
    await previousCopy;
    await copyCheckRun(octokit, owner, repo, checkRun, passedRun, currentRun);
  }, Promise.resolve());
  return passedRunCheckRuns.map((checkRun): string => checkRun.name);
};
