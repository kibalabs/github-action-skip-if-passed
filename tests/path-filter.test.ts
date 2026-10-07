import { describe, expect, it } from 'vitest';

import { isRelevantChange, matchesPatterns, readTriggerPathFilter } from '../src/path-filter';

describe('matchesPatterns', () => {
  it.each([
    ['feature/*', 'feature/my-branch', true],
    ['feature/*', 'feature/your/branch', false],
    ['feature/**', 'feature/your/branch', true],
    ['**', 'any/file.txt', true],
    ['*.js', 'app.js', true],
    ['*.js', 'src/app.js', false],
    ['**.js', 'src/app.js', true],
    ['docs/*', 'docs/README.md', true],
    ['docs/*', 'docs/file/README.md', false],
    ['docs/**', 'docs/mona/octocat.txt', true],
    ['docs/**/*.md', 'docs/a/b/c/README.md', true],
    ['docs/**/*.md', 'docs/README.md', true],
    ['**/docs/**', '/a/b/c/docs/d/file', true],
    ['**/README.md', 'README.md', true],
    ['**/README.md', 'server/docs/README.md', true],
    ['**/*src/**', 'a/src/app.js', true],
    ['**/*-post.md', 'my-post.md', true],
    ['**/*-post.md', 'path/their-post.md', true],
    ['*.jsx?', 'page.js', true],
    ['*.jsx?', 'page.jsx', true],
    ['*.jsx?', 'page.jsxx', false],
    ['[CB]at', 'Bat', true],
    ['[CB]at', 'Mat', false],
    ['v2*', 'v2.1', true],
    ['.github/**', '.github/workflows/check.yml', true],
    ['api/**', 'apiary/file.py', false],
  ])('%s matches %s: %s', (pattern: string, file: string, isMatched: boolean) => {
    expect(matchesPatterns(file, [pattern])).toBe(isMatched);
  });

  it('applies negated patterns in order', () => {
    expect(matchesPatterns('docs/secret.md', ['docs/**', '!docs/secret.md'])).toBe(false);
    expect(matchesPatterns('docs/public.md', ['docs/**', '!docs/secret.md'])).toBe(true);
    expect(matchesPatterns('docs/secret.md', ['docs/**', '!docs/*.md', 'docs/secret.md'])).toBe(true);
  });
});

describe('isRelevantChange', () => {
  it('needs one matching file for paths', () => {
    expect(isRelevantChange(['README.md', 'api/app.py'], { type: 'paths', patterns: ['api/**'] })).toBe(true);
    expect(isRelevantChange(['README.md', 'app/main.ts'], { type: 'paths', patterns: ['api/**'] })).toBe(false);
  });

  it('needs one file outside the ignored paths for paths-ignore', () => {
    expect(isRelevantChange(['docs/a.md', 'api/app.py'], { type: 'paths-ignore', patterns: ['docs/**'] })).toBe(true);
    expect(isRelevantChange(['docs/a.md', 'docs/b.md'], { type: 'paths-ignore', patterns: ['docs/**'] })).toBe(false);
  });
});

describe('readTriggerPathFilter', () => {
  it('reads block and inline paths lists for the triggering event', () => {
    const workflow = "on:\n  push:\n    branches: [main]\n    paths: ['push/**']\n  pull_request:\n    paths:\n      - 'api/**'  # the api\n      - \".github/workflows/check.yml\"\njobs: {}\n";
    expect(readTriggerPathFilter(workflow, 'pull_request')).toEqual({ type: 'paths', patterns: ['api/**', '.github/workflows/check.yml'] });
    expect(readTriggerPathFilter(workflow, 'push')).toEqual({ type: 'paths', patterns: ['push/**'] });
  });

  it('reads paths-ignore', () => {
    expect(readTriggerPathFilter('on:\n  pull_request:\n    paths-ignore: [docs/**]\n', 'pull_request')).toEqual({ type: 'paths-ignore', patterns: ['docs/**'] });
  });

  it('has no filter when the trigger has none', () => {
    expect(readTriggerPathFilter('on: pull_request\n', 'pull_request')).toBeNull();
    expect(readTriggerPathFilter('on: [push, pull_request]\n', 'pull_request')).toBeNull();
    expect(readTriggerPathFilter('on:\n  pull_request:\n', 'pull_request')).toBeNull();
    expect(readTriggerPathFilter('on:\n  pull_request:\n    branches: [main]\n', 'pull_request')).toBeNull();
    expect(readTriggerPathFilter('on:\n  push:\n    paths: [api/**]\n', 'pull_request')).toBeNull();
  });
});
