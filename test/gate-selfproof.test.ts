import { describe, expect, it } from "vitest";

// MR-gate self-proof (TEST_INFRA): deliberately failing test.
// This branch must be blocked from merging into develop by the CI status check.
describe("gate self-proof", () => {
  it("fails on purpose", () => {
    expect(1 + 1).toBe(3);
  });
});
