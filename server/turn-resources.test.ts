import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adoptTurnResources, retargetTurnOwner, TurnResources, workspaceResource } from "./turn-resources.ts";

const a = { threadId: "a", generation: "1" };
const b = { threadId: "b", generation: "2" };

describe("thread resource ownership", () => {
  it("allows independent resources but holds the same screen across calls", () => {
    const leases = new TurnResources();
    expect(leases.claim("computer:host", a)).toBe(true);
    expect(leases.claim("computer:host", a)).toBe(true);
    expect(leases.claim("computer:host", b)).toBe(false);
    expect(leases.blocker("computer:host", b)).toEqual(a);
    expect(leases.blocker("computer:host", a)).toBeUndefined();
    expect(leases.claim("browser:other", b)).toBe(true);
    leases.release(a);
    expect(leases.blocker("computer:host", b)).toBeUndefined();
    expect(leases.claim("computer:host", b)).toBe(true);
    leases.release(a);
    expect(leases.owns("computer:host", b)).toBe(true);
  });

  it("does not release a replacement generation", () => {
    const leases = new TurnResources();
    const next = { ...a, generation: "next" };
    expect(leases.claim("browser:one", a)).toBe(true);
    expect(leases.claim("browser:one", next)).toBe(false);
    leases.release(a);
    expect(leases.claim("browser:one", next)).toBe(true);
    leases.release(a);
    expect(leases.owns("browser:one", next)).toBe(true);
  });

  it("releases one resource early without dropping the owner's others", () => {
    const leases = new TurnResources();
    expect(leases.claim("computer:vm:shared", a)).toBe(true);
    expect(leases.claim("browser:one", a)).toBe(true);
    leases.releaseOne("computer:vm:shared", a);
    expect(leases.owns("computer:vm:shared", a)).toBe(false);
    expect(leases.claim("computer:vm:shared", b)).toBe(true);
    expect(leases.owns("browser:one", a)).toBe(true);
    // Only the exact owner may drop it: a stale generation is a no-op.
    leases.releaseOne("computer:vm:shared", { ...b, generation: "stale" });
    expect(leases.owns("computer:vm:shared", b)).toBe(true);
  });

  it("hands a thread's folder to the replacement generation instead of locking it", () => {
    const root = mkdtempSync(join(tmpdir(), "omb-thread-adopt-"));
    try {
      mkdirSync(join(root, "task"));
      const folder = workspaceResource(join(root, "task"));
      const leases = new TurnResources();
      const abandoned = { threadId: "chat", generation: "abandoned" };
      const replacement = { threadId: "chat", generation: "replacement" };
      const other = { threadId: "other", generation: "1" };
      expect(leases.claim(folder, abandoned)).toBe(true);
      expect(leases.claim("computer:vm:shared", abandoned)).toBe(true);
      // The retry used to install a new generation and then fail this claim,
      // while the abandoned generation never reached turn.completed.
      expect(leases.claim(folder, replacement)).toBe(false);
      adoptTurnResources(leases, abandoned, replacement);
      expect(leases.claim(folder, replacement)).toBe(true);
      expect(leases.owns("computer:vm:shared", replacement)).toBe(true);
      expect(leases.claim(folder, other)).toBe(false);
      // The abandoned settle must not free what the replacement now holds.
      leases.release(abandoned);
      expect(leases.owns(folder, replacement)).toBe(true);
      expect(leases.owns("computer:vm:shared", replacement)).toBe(true);
      const computer = retargetTurnOwner({ owner: abandoned, resource: "computer:vm:shared" }, abandoned, replacement);
      expect(computer).toEqual({ owner: replacement, resource: "computer:vm:shared" });
      expect(retargetTurnOwner({ owner: other, resource: "computer:vm:shared" }, abandoned, replacement)?.owner).toEqual(other);
      leases.release(replacement);
      expect(leases.claim(folder, other)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prevents parent/child project overlap and symlink aliases, not sibling folders", () => {
    const root = mkdtempSync(join(tmpdir(), "omb-thread-resources-"));
    try {
      mkdirSync(join(root, "project", "nested"), { recursive: true });
      mkdirSync(join(root, "project-other"));
      symlinkSync(join(root, "project"), join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
      const leases = new TurnResources();
      expect(leases.claim(workspaceResource(join(root, "project")), a)).toBe(true);
      expect(leases.claim(workspaceResource(join(root, "alias")), b)).toBe(false);
      expect(leases.claim(workspaceResource(join(root, "project", "nested")), b)).toBe(false);
      expect(leases.claim(workspaceResource(root), b)).toBe(false);
      expect(leases.claim(workspaceResource(join(root, "project-other")), b)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats differently cased paths as one workspace on case-insensitive volumes", ({ skip }) => {
    const root = mkdtempSync(join(tmpdir(), "omb-thread-case-"));
    try {
      const folder = join(root, "Project");
      const alias = join(root, "project");
      mkdirSync(folder);
      if (!existsSync(alias)) return skip();
      expect(workspaceResource(alias)).toBe(workspaceResource(folder));
      const leases = new TurnResources();
      expect(leases.claim(workspaceResource(folder), a)).toBe(true);
      expect(leases.claim(workspaceResource(alias), b)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
