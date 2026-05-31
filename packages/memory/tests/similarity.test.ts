import { describe, it, expect } from "vitest";
import { jaccard, keywordScore } from "../src/similarity.js";

describe("similarity", () => {
  it("jaccard of identical strings is 1", () => {
    expect(jaccard("the quick brown fox", "the quick brown fox")).toBe(1);
  });

  it("jaccard of disjoint sets is 0", () => {
    expect(jaccard("apples", "pears")).toBe(0);
  });

  it("jaccard is symmetric", () => {
    const a = "the quick brown fox";
    const b = "the lazy dog";
    expect(jaccard(a, b)).toBe(jaccard(b, a));
  });

  it("jaccard ignores case and punctuation", () => {
    expect(jaccard("Hello, World!", "hello world")).toBe(1);
  });

  it("keywordScore returns fraction of query tokens in corpus", () => {
    expect(keywordScore("pnpm typescript", "we use pnpm here")).toBeCloseTo(0.5);
    expect(keywordScore("", "anything")).toBe(0);
    expect(keywordScore("nothing matches", "completely different")).toBe(0);
  });
});
