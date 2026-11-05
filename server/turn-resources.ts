import { realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

export type TurnOwner = { threadId: string; generation: string };

/** One harness owns the data directory. Claims are synchronous and last for
 * the whole turn, not just a click: a screenshot and its following click
 * must see the same desktop. These coordinate app-managed resources; they
 * are not a sandbox for arbitrary shell commands. */
export class TurnResources {
  private readonly owners = new Map<string, TurnOwner>();

  blocker(resource: string, owner: TurnOwner): TurnOwner | undefined {
    for (const [key, current] of this.owners) {
      if (overlaps(key, resource) && !sameOwner(current, owner)) return current;
    }
    return undefined;
  }

  claim(resource: string, owner: TurnOwner): boolean {
    if (this.blocker(resource, owner)) return false;
    this.owners.set(resource, owner);
    return true;
  }

  owns(resource: string, owner: TurnOwner): boolean {
    const current = this.owners.get(resource);
    return Boolean(current && sameOwner(current, owner));
  }

  release(owner: TurnOwner): void {
    for (const [key, current] of this.owners) {
      if (sameOwner(current, owner)) this.owners.delete(key);
    }
  }

  /** Drop one of an owner's claims early, when the sequence that took it
   * could not finish. The owner's other claims stand until settle. */
  releaseOne(resource: string, owner: TurnOwner): void {
    if (this.owns(resource, owner)) this.owners.delete(resource);
  }

  /** The same thread is starting the turn again (a checkpoint or quota
   * retry). The abandoned generation never publishes turn.completed, so
   * its claims have to move onto the replacement or they block this
   * thread's folder until the process restarts. A different thread is
   * never adopted. */
  reassign(from: TurnOwner, to: TurnOwner): void {
    if (from.threadId !== to.threadId || sameOwner(from, to)) return;
    for (const [key, current] of this.owners) {
      if (sameOwner(current, from)) this.owners.set(key, to);
    }
  }
}

/** Move every claim the abandoned generation still holds onto the
 * replacement, before that replacement is recorded as the thread's owner.
 * A stale turn.completed for the abandoned generation then releases
 * nothing. */
export function adoptTurnResources(resources: TurnResources, from: TurnOwner | undefined, to: TurnOwner): void {
  if (!from) return;
  resources.reassign(from, to);
}

/** Side tables that remember an owner by thread must follow the same
 * adoption, or a later release of the replacement leaves the old
 * generation's computer slot behind. */
export function retargetTurnOwner<T extends { owner: TurnOwner }>(slot: T | undefined, from: TurnOwner, to: TurnOwner): T | undefined {
  if (!slot || !sameOwner(slot.owner, from)) return slot;
  return { ...slot, owner: to };
}

function sameOwner(a: TurnOwner, b: TurnOwner): boolean {
  return a.threadId === b.threadId && a.generation === b.generation;
}

export function workspaceResource(cwd: string): string {
  // Selected folders must exist before the engine starts. Resolve symlinks
  // and native filename casing so aliases cannot grant two writers to the
  // same project on case-insensitive volumes.
  const canonical = realpathSync.native(resolve(cwd));
  return `workspace:${process.platform === "win32" ? canonical.toLowerCase() : canonical}`;
}

function overlaps(a: string, b: string): boolean {
  if (a === b) return true;
  if (!a.startsWith("workspace:") || !b.startsWith("workspace:")) return false;
  const left = a.slice("workspace:".length);
  const right = b.slice("workspace:".length);
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep) && !/^[A-Za-z]:/.test(path));
  };
  return contains(left, right) || contains(right, left);
}
