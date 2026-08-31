import assert from 'node:assert/strict';
import test from 'node:test';
import { configFromEnvironment } from '../src/config.js';

const required = {
  BUNNY_STORAGE_ZONE_NAME: 'zone',
  BUNNY_ACCESS_KEY: 'storage-key',
};

test('full purge is disabled by default and can be enabled from the environment', () => {
  assert.equal(configFromEnvironment(required).fullPurge, false);
  assert.equal(configFromEnvironment({ ...required, BUNNY_FULL_PURGE: 'true' }).fullPurge, true);
});

test('full purge environment option only accepts booleans', () => {
  assert.throws(
    () => configFromEnvironment({ ...required, BUNNY_FULL_PURGE: 'yes' }),
    /BUNNY_FULL_PURGE must be true or false/,
  );
});
