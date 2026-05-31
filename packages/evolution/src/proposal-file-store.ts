/**
 * ProposalFileStore — JSON-file-per-proposal audit queue with status transitions.
 *
 * Each proposal is written as `<id>.json` so humans can inspect / approve /
 * reject offline. Status transitions (approve / reject / apply) rewrite the
 * same file in place.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { existsSync } from "node:fs";
import type { EvolutionProposal, ProposalStore } from "./evolution-types.js";

export class ProposalFileStore implements ProposalStore {
  constructor(private readonly dirPath: string) {}

  private filePath(id: string): string {
    return path.join(this.dirPath, `${id}.json`);
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.dirPath, { recursive: true });
  }

  async enqueue(proposal: EvolutionProposal): Promise<EvolutionProposal> {
    await this.ensureDir();
    const filled: EvolutionProposal = {
      ...proposal,
      id: proposal.id ?? newId(),
      createdAt: proposal.createdAt ?? new Date().toISOString(),
      status: proposal.status ?? "pending",
    };
    await fs.writeFile(this.filePath(filled.id!), JSON.stringify(filled, null, 2));
    return filled;
  }

  async get(id: string): Promise<EvolutionProposal | undefined> {
    const file = this.filePath(id);
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(await fs.readFile(file, "utf-8"));
    } catch {
      return undefined;
    }
  }

  async list(filter?: { status?: EvolutionProposal["status"] }): Promise<EvolutionProposal[]> {
    if (!existsSync(this.dirPath)) return [];
    const files = await fs.readdir(this.dirPath);
    const proposals: EvolutionProposal[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const p: EvolutionProposal = JSON.parse(
          await fs.readFile(path.join(this.dirPath, file), "utf-8"),
        );
        if (!filter?.status || p.status === filter.status) proposals.push(p);
      } catch {
        // skip malformed
      }
    }
    // Stable order by createdAt asc (FIFO).
    proposals.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
    return proposals;
  }

  async approve(id: string, note?: string): Promise<EvolutionProposal | undefined> {
    return this.updateStatus(id, "approved", note);
  }

  async reject(id: string, note?: string): Promise<EvolutionProposal | undefined> {
    return this.updateStatus(id, "rejected", note);
  }

  async markApplied(id: string): Promise<void> {
    await this.updateStatus(id, "applied");
  }

  async delete(id: string): Promise<void> {
    const file = this.filePath(id);
    await fs.unlink(file).catch(() => void 0);
  }

  private async updateStatus(
    id: string,
    status: EvolutionProposal["status"],
    note?: string,
  ): Promise<EvolutionProposal | undefined> {
    const existing = await this.get(id);
    if (!existing) return undefined;
    const updated: EvolutionProposal = {
      ...existing,
      status,
      ...(note ? { note } : {}),
    };
    await fs.writeFile(this.filePath(id), JSON.stringify(updated, null, 2));
    return updated;
  }
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `prop-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
