// @vitest-environment jsdom
import { version } from 'react';
import { version as domVersion } from 'react-dom';
import { describe, expect, it } from 'vitest';

const major = (text: string) => Number(text.split('.')[0]);

describe('the React under test', () => {
  it('is one version of React and React DOM, the major the run asked for', () => {
    expect(major(domVersion)).toBe(major(version));
    if (process.env.REACT_MAJOR) expect(major(version)).toBe(Number(process.env.REACT_MAJOR));
  });
});
