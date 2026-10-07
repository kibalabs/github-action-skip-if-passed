# GitHub Action - Skip If Passed

Skip the rest of a job when the files it checks already passed on an earlier commit.

On a pull request with several parts (say `api/` and `app/`), a push that only changes `api/` still runs the `app/` checks. This action lets those checks finish in seconds by reusing the result of the last run that passed on the same `app/` files.

## Example

```yaml
on:
  pull_request:
    paths:
      - 'app/**'
      - '.github/workflows/app-check.yml'
jobs:
  app-check:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: read
      checks: write
    steps:
      - uses: kibalabs/github-action-skip-if-passed@v1
      - uses: actions/checkout@v7
        if: env.CHECKS_ALREADY_PASSED != 'true'
      - name: Run tests
        if: env.CHECKS_ALREADY_PASSED != 'true'
        run: make test
```

When the job is skipped, the action sets `CHECKS_ALREADY_PASSED=true` for the rest of the job. Steps that don't know about it need `if: env.CHECKS_ALREADY_PASSED != 'true'`. [Run Docker Checks](https://github.com/kibalabs/github-action-run-docker-checks) checks it by itself.

## When it skips

The job is skipped when an earlier run of the same workflow for the same event **succeeded**, the same job also concluded `success`, and either:

- it ran on exactly the same files (same git tree), or
- no commit since then changed a file this job checks.

A run that failed, was cancelled or timed out never counts, so a failing check runs again on the next push. Only `push` and `pull_request` events can be skipped; every other event always runs.

For pull requests, it compares the PR's files, not the merge with the base branch, so a PR whose files already passed is skipped even if the base branch moved since (as with other tree-based skip tools).

It looks back at most 50 commits and 500 workflow runs. If the history can't be read, the job runs as normal and the action logs a warning.

## Checks of the skipped run

A skipped run doesn't produce its own checks, so the action copies them from the run that passed: every check run on that run's commit whose `external_id` is that run's id is created again on the current commit, with the same result, output and annotations, and a note saying where it came from. [Run Docker Checks](https://github.com/kibalabs/github-action-run-docker-checks) sets `external_id` this way; other tools can too.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `github-token` | `${{ github.token }}` | Needs `actions: read`, `contents: read` and `checks: write` (to copy checks). |
| `paths` | the trigger's filter | Path patterns this job checks, one per line, overriding the trigger's filter. |

## Outputs

| Output | Description |
| --- | --- |
| `should-skip` | `true` when the rest of the job can be skipped, otherwise `false`. |
| `reason` | Why the job is or is not skipped. |
| `passed-run-url` | URL of the earlier run that passed on the same files, when skipping. |

## Development

Build with `make build`, which bundles `src/` into `runnable/index.js`. GitHub runs that file directly, so commit it with every source change. Run the tests with `make test`.

To release, bump `version` in `package.json` in a PR, then run the Release workflow on `main` (Actions → Release → Run workflow). It tags `vX.Y.Z`, publishes the release and moves the `vX` tag to it, so `@v1` always points at the latest 1.x release. Versions with a pre-release suffix (e.g. `1.1.0-rc1`) are published as pre-releases and don't move `vX`. Only the release workflow can push version tags.
