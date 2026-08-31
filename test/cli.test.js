import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArguments } from '../src/cli.js';

test('full purge CLI option is parsed independently of other deployment options', () => {
  assert.deepEqual(parseArguments(['--interactive', '--full-purge']), {
    dryRun: false,
    interactive: true,
    fullPurge: true,
    help: false,
  });
});
