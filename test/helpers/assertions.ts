import assert from 'node:assert/strict';

/** Narrow `T | null | undefined` to `T`, failing the test with a clear message when the value is missing. */
export function defined<T>(value: T | null | undefined, what = 'value'): T {
  assert.ok(value !== undefined && value !== null, `expected ${what} to be present`);
  return value;
}
