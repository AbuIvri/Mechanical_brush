import { describe, it, expect } from "vitest";
import { isInside } from "../shared/pathGuard";

describe("isInside", () => {
  const root = "/data/photos";

  it("accepts the root and anything under it", () => {
    expect(isInside(root, root)).toBe(true);
    expect(isInside(root, "/data/photos/avner/1.png")).toBe(true);
    expect(isInside(root, "/data/photos/./avner/../dana/2.png")).toBe(true);
  });

  it("refuses a sibling that merely shares the prefix", () => {
    // The bug a startsWith check would have: a different folder, same first letters.
    expect(isInside(root, "/data/photos-private/secrets.png")).toBe(false);
  });

  it("refuses anything that climbs out", () => {
    expect(isInside(root, "/data/photos/../../etc/passwd")).toBe(false);
    expect(isInside(root, "/etc/passwd")).toBe(false);
    expect(isInside(root, "/")).toBe(false);
  });

  it("refuses a traversal hidden inside a name from the sheet", () => {
    expect(isInside(root, "/data/photos/../../../Users/me/.ssh/id_rsa")).toBe(false);
  });
});
