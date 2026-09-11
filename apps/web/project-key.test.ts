import test from 'node:test';
import assert from 'node:assert/strict';
import { projectKey } from './src/project-key.ts';

test('Windows project identity ignores drive casing, separators and trailing slashes', () => {
  assert.equal(projectKey('C:\\Users\\kouta\\project\\editor'), projectKey('c:/Users/kouta/project/editor/'));
  assert.equal(projectKey('C:\\PROJECTS\\Editor'), projectKey('c:\\projects\\editor\\'));
  assert.notEqual(projectKey('C:/one/editor'), projectKey('C:/two/editor'));
  assert.notEqual(projectKey('/projects/Editor'), projectKey('/projects/editor'));
  assert.equal(projectKey('/projects/editor/'), projectKey('/projects/editor'));
});
