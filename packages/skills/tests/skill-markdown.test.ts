import { describe, it, expect } from "vitest";
import {
  parseSkillMarkdown,
  serializeSkillMarkdown,
  slugify,
} from "../src/skill-markdown.js";
import type { Skill } from "../src/skill-types.js";

function mkSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: "skill-deploy-nextjs",
    name: "Deploy Next.js to Vercel",
    description: "Standard procedure for deploying a Next.js app to Vercel",
    type: "prompt",
    content: "1. pnpm test\n2. pnpm build\n3. vercel --prod",
    tags: ["deploy", "vercel"],
    trigger: { keywords: ["deploy", "vercel"], examples: ["帮我部署到 Vercel"] },
    metadata: {
      createdBy: "human",
      createdAt: "2026-05-05T00:00:00.000Z",
      usageCount: 0,
      successCount: 0,
      confidence: 0.9,
    },
    ...overrides,
  };
}

describe("slugify", () => {
  it("lowercases and replaces non-alphanumerics with dashes", () => {
    expect(slugify("Deploy Next.js to Vercel")).toBe("deploy-next-js-to-vercel");
  });
  it("collapses repeated separators and trims", () => {
    expect(slugify("  ---Hello___World!!!  ")).toBe("hello-world");
  });
  it("preserves non-ASCII letters", () => {
    expect(slugify("部署 Next.js")).toBe("部署-next-js");
  });
  it("truncates to 64 chars without trailing dash", () => {
    const slug = slugify("a".repeat(200) + " - " + "b".repeat(200));
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug.endsWith("-")).toBe(false);
  });
  it("falls back to 'skill' for empty input", () => {
    expect(slugify("")).toBe("skill");
    expect(slugify("???")).toBe("skill");
  });
});

describe("parseSkillMarkdown / serializeSkillMarkdown", () => {
  it("round-trips a full skill", () => {
    const original = mkSkill();
    const raw = serializeSkillMarkdown(original);
    const parsed = parseSkillMarkdown(raw);
    // `scope` is a runtime-only field set by the store, not the markdown.
    expect(parsed).toEqual(original);
  });

  it("handles descriptions that contain colons and quotes", () => {
    const original = mkSkill({
      description: `Procedure: deploy "production" to Vercel — includes a check.`,
      content: "Step 1: do a thing\nStep 2: do another",
    });
    const raw = serializeSkillMarkdown(original);
    const parsed = parseSkillMarkdown(raw);
    expect(parsed.description).toBe(original.description);
    expect(parsed.content).toBe(original.content);
  });

  it("auto-generates id if missing", () => {
    const raw = `---\nname: Say Hello\ndescription: Greet the user\n---\nHello!`;
    const parsed = parseSkillMarkdown(raw);
    expect(parsed.id).toBe("skill-say-hello");
    expect(parsed.name).toBe("Say Hello");
    expect(parsed.content).toBe("Hello!");
    expect(parsed.type).toBe("prompt");
  });

  it("throws on missing name or description", () => {
    expect(() =>
      parseSkillMarkdown(`---\ndescription: x\n---\nbody`),
    ).toThrow(/name/);
    expect(() =>
      parseSkillMarkdown(`---\nname: x\n---\nbody`),
    ).toThrow(/description/);
  });

  it("throws on missing frontmatter delimiter", () => {
    expect(() => parseSkillMarkdown("no frontmatter here")).toThrow(
      /frontmatter/,
    );
  });

  it("clamps confidence to [0, 1]", () => {
    const raw = `---\nname: S\ndescription: d\nconfidence: 5\n---\nbody`;
    const parsed = parseSkillMarkdown(raw);
    expect(parsed.metadata.confidence).toBe(1);
  });

  it("omits empty trigger / tags from serialized output", () => {
    const s = mkSkill({ trigger: undefined, tags: [] });
    const raw = serializeSkillMarkdown(s);
    expect(raw).not.toMatch(/^trigger:/m);
    expect(raw).not.toMatch(/^tags:/m);
  });
});
