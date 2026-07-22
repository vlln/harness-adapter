import { describe, expect, it } from "vitest";
import * as ahs from "../src/index";

describe("library entry", () => {
  it("exposes the AHS schemas from the root entry", () => {
    expect(ahs.ManifestSchema).toBeDefined();
    expect(ahs.AhsRecordSchema).toBeDefined();
    expect(ahs.RelationSchema).toBeDefined();
    expect(ahs.UsageSchema).toBeDefined();
    expect(ahs.BlobRefSchema).toBeDefined();
  });
});
