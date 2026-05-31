import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ProposalFileStore } from "../src/proposal-file-store.js";
import type { EvolutionProposal } from "../src/evolution-types.js";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "walle-proposals-"));
}

function mkMemoryProposal(): Omit<EvolutionProposal, "id" | "createdAt" | "status"> {
  return {
    type: "memory",
    reason: "explicit_remember",
    payload: {
      type: "preference",
      content: "user prefers pnpm",
      importance: 0.8,
      confidence: 0.9,
      scope: "long",
      tags: ["package-manager"],
    },
  };
}

describe("ProposalFileStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await tmpDir();
  });

  it("enqueues a proposal and assigns id + createdAt + status=pending", async () => {
    const store = new ProposalFileStore(dir);
    const enqueued = await store.enqueue(mkMemoryProposal());
    expect(enqueued.id).toBeTruthy();
    expect(enqueued.createdAt).toBeTruthy();
    expect(enqueued.status).toBe("pending");

    const loaded = await store.get(enqueued.id!);
    expect(loaded).toBeTruthy();
    expect((loaded!.payload as any).content).toBe("user prefers pnpm");
  });

  it("list filters by status and returns in FIFO order", async () => {
    const store = new ProposalFileStore(dir);
    const a = await store.enqueue(mkMemoryProposal());
    // Tiny wait to make createdAt strictly ordered.
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.enqueue(mkMemoryProposal());

    await store.approve(a.id!);

    const pending = await store.list({ status: "pending" });
    expect(pending.map((p) => p.id)).toEqual([b.id]);

    const approved = await store.list({ status: "approved" });
    expect(approved.map((p) => p.id)).toEqual([a.id]);

    const all = await store.list();
    expect(all.map((p) => p.id)).toEqual([a.id, b.id]);
  });

  it("approve / reject / markApplied transitions status", async () => {
    const store = new ProposalFileStore(dir);
    const p = await store.enqueue(mkMemoryProposal());
    await store.approve(p.id!, "looks good");
    let updated = await store.get(p.id!);
    expect(updated!.status).toBe("approved");
    expect(updated!.note).toBe("looks good");

    await store.markApplied(p.id!);
    updated = await store.get(p.id!);
    expect(updated!.status).toBe("applied");

    // reject unknown id returns undefined
    const missing = await store.reject("nope");
    expect(missing).toBeUndefined();
  });

  it("delete removes the file", async () => {
    const store = new ProposalFileStore(dir);
    const p = await store.enqueue(mkMemoryProposal());
    await store.delete(p.id!);
    expect(await store.get(p.id!)).toBeUndefined();
  });
});
