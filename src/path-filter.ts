import { parse as parseYaml } from 'yaml';

import { IPathFilter } from './model';

// NOTE(krishan711): follows GitHub's filter pattern cheat sheet rather than standard globs: ? and + apply to the preceding character like in a regex
export const patternToRegExp = (pattern: string): RegExp => {
  let expression = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '\\' && index + 1 < pattern.length) {
      expression += `\\${pattern[index + 1]}`;
      index += 1;
    } else if (character === '*' && pattern[index + 1] === '*') {
      index += 1;
      if (pattern[index + 1] === '/') {
        index += 1;
        expression += '(?:.*/)?';
      } else {
        expression += '.*';
      }
    } else if (character === '*') {
      expression += '[^/]*';
    } else if (character === '?' || character === '+') {
      expression += character;
    } else if (character === '[' && pattern.indexOf(']', index) > index) {
      const closingIndex = pattern.indexOf(']', index);
      expression += pattern.slice(index, closingIndex + 1);
      index = closingIndex;
    } else {
      expression += character.replace(/[.^${}()|[\]]/g, '\\$&');
    }
  }
  return new RegExp(`^${expression}$`);
};

// NOTE(krishan711): like GitHub, patterns are applied in order so a later !pattern excludes and a later pattern includes again
export const matchesPatterns = (file: string, patterns: string[]): boolean => {
  return patterns.reduce((isMatched: boolean, pattern: string): boolean => {
    if (pattern.startsWith('!')) {
      return patternToRegExp(pattern.slice(1)).test(file) ? false : isMatched;
    }
    return patternToRegExp(pattern).test(file) ? true : isMatched;
  }, false);
};

export const isRelevantChange = (changedFiles: string[], pathFilter: IPathFilter): boolean => {
  if (pathFilter.type === 'paths') {
    return changedFiles.some((file: string): boolean => matchesPatterns(file, pathFilter.patterns));
  }
  return changedFiles.some((file: string): boolean => !matchesPatterns(file, pathFilter.patterns));
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
};

export const readTriggerPathFilter = (workflowContent: string, eventName: string): IPathFilter | null => {
  const triggers = asRecord(asRecord(parseYaml(workflowContent))?.on);
  const eventConfig = triggers ? asRecord(triggers[eventName]) : null;
  if (!eventConfig) {
    return null;
  }
  if (Array.isArray(eventConfig.paths)) {
    return { type: 'paths', patterns: eventConfig.paths.map(String) };
  }
  if (Array.isArray(eventConfig['paths-ignore'])) {
    return { type: 'paths-ignore', patterns: eventConfig['paths-ignore'].map(String) };
  }
  return null;
};
