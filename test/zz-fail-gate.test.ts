import { describe, it, expect } from 'vitest';
describe('fail gate probe', () => {
  it('intentionally fails to verify merge blocking', () => {
    expect(1).toBe(2);
  });
});
