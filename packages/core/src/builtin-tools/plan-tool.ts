/**
 * Built-in plan tool: structured planning for complex objectives
 *
 * Provides create/update/get/list/delete/update_step operations on plans.
 * Each plan has a title and ordered steps with status tracking.
 */

import { defineTool } from "../tool.js";

// ─── Types ────────────────────────────────────────────────────────

export interface PlanStep {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "skipped";
}

export interface Plan {
  id: string;
  title: string;
  steps: PlanStep[];
  status: "active" | "completed" | "archived";
  createdAt: string;
  updatedAt: string;
}

// ─── In-memory Store ──────────────────────────────────────────────

const planStore = new Map<string, Plan>();

// ─── Input Types ──────────────────────────────────────────────────

export interface PlanToolInput {
  action: "create" | "update" | "get" | "list" | "delete" | "update_step";
  planId?: string;
  title?: string;
  steps?: Array<{ content: string; status?: PlanStep["status"] }>;
  stepId?: string;
  stepStatus?: PlanStep["status"];
  stepContent?: string;
}

// ─── Tool Definition ──────────────────────────────────────────────

export const planTool = defineTool({
  name: "plan",
  description:
    "Create and manage structured execution plans. Use for breaking down complex objectives into ordered steps with status tracking. Actions: create, update, get, list, delete, update_step.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "update", "get", "list", "delete", "update_step"],
        description:
          "Action to perform. 'create': new plan, 'update': modify plan title/steps, 'get': retrieve a plan, 'list': list all plans, 'delete': remove a plan, 'update_step': update a single step's status/content.",
      },
      planId: {
        type: "string",
        description: "Plan ID. Required for get, update, delete, update_step.",
      },
      title: {
        type: "string",
        description: "Plan title. Required for create, optional for update.",
      },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "Step description" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed", "skipped"],
              description: "Step status. Defaults to 'pending'.",
            },
          },
          required: ["content"],
        },
        description: "Plan steps. Required for create, optional for update (replaces all steps).",
      },
      stepId: {
        type: "string",
        description: "Step ID. Required for update_step.",
      },
      stepStatus: {
        type: "string",
        enum: ["pending", "in_progress", "completed", "skipped"],
        description: "New status for a step. Used with update_step.",
      },
      stepContent: {
        type: "string",
        description: "New content for a step. Used with update_step.",
      },
    },
    required: ["action"],
  },
  riskLevel: "low",
  tags: ["builtin", "planning"],

  async execute(input: PlanToolInput) {
    try {
      switch (input.action) {
        case "create":
          return createPlan(input);
        case "update":
          return updatePlan(input);
        case "get":
          return getPlan(input);
        case "list":
          return listPlans();
        case "delete":
          return deletePlan(input);
        case "update_step":
          return updateStep(input);
        default:
          return { error: `Unknown action: ${input.action}` };
      }
    } catch (error) {
      return { error: String(error) };
    }
  },
});

// ─── Action Handlers ──────────────────────────────────────────────

function createPlan(input: PlanToolInput) {
  if (!input.title) {
    return { error: "title is required for 'create' action" };
  }
  if (!input.steps || input.steps.length === 0) {
    return { error: "steps (non-empty array) is required for 'create' action" };
  }

  const id = `plan_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const now = new Date().toISOString();

  const plan: Plan = {
    id,
    title: input.title,
    steps: input.steps.map((s, idx) => ({
      id: `step_${idx + 1}`,
      content: s.content,
      status: s.status ?? "pending",
    })),
    status: "active",
    createdAt: now,
    updatedAt: now,
  };

  planStore.set(id, plan);

  return {
    status: "success",
    action: "create",
    plan,
  };
}

function updatePlan(input: PlanToolInput) {
  if (!input.planId) {
    return { error: "planId is required for 'update' action" };
  }

  const plan = planStore.get(input.planId);
  if (!plan) {
    return { error: `Plan not found: ${input.planId}` };
  }

  if (input.title) {
    plan.title = input.title;
  }

  if (input.steps) {
    plan.steps = input.steps.map((s, idx) => ({
      id: `step_${idx + 1}`,
      content: s.content,
      status: s.status ?? "pending",
    }));
  }

  // Auto-update plan status
  if (plan.steps.length > 0 && plan.steps.every((s) => s.status === "completed" || s.status === "skipped")) {
    plan.status = "completed";
  } else {
    plan.status = "active";
  }

  plan.updatedAt = new Date().toISOString();

  return {
    status: "success",
    action: "update",
    plan,
  };
}

function getPlan(input: PlanToolInput) {
  if (!input.planId) {
    return { error: "planId is required for 'get' action" };
  }

  const plan = planStore.get(input.planId);
  if (!plan) {
    return { error: `Plan not found: ${input.planId}` };
  }

  const progress = {
    total: plan.steps.length,
    completed: plan.steps.filter((s) => s.status === "completed").length,
    inProgress: plan.steps.filter((s) => s.status === "in_progress").length,
    pending: plan.steps.filter((s) => s.status === "pending").length,
    skipped: plan.steps.filter((s) => s.status === "skipped").length,
  };

  return { plan, progress };
}

function listPlans() {
  const plans = [...planStore.values()].map((p) => ({
    id: p.id,
    title: p.title,
    status: p.status,
    stepsCount: p.steps.length,
    completedSteps: p.steps.filter((s) => s.status === "completed").length,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }));

  return { totalPlans: plans.length, plans };
}

function deletePlan(input: PlanToolInput) {
  if (!input.planId) {
    return { error: "planId is required for 'delete' action" };
  }

  if (!planStore.has(input.planId)) {
    return { error: `Plan not found: ${input.planId}` };
  }

  planStore.delete(input.planId);
  return { status: "success", action: "delete", planId: input.planId };
}

function updateStep(input: PlanToolInput) {
  if (!input.planId) {
    return { error: "planId is required for 'update_step' action" };
  }
  if (!input.stepId) {
    return { error: "stepId is required for 'update_step' action" };
  }

  const plan = planStore.get(input.planId);
  if (!plan) {
    return { error: `Plan not found: ${input.planId}` };
  }

  const step = plan.steps.find((s) => s.id === input.stepId);
  if (!step) {
    return { error: `Step not found: ${input.stepId} in plan ${input.planId}` };
  }

  if (input.stepStatus) {
    step.status = input.stepStatus;
  }
  if (input.stepContent !== undefined) {
    step.content = input.stepContent;
  }

  // Auto-update plan status
  if (plan.steps.every((s) => s.status === "completed" || s.status === "skipped")) {
    plan.status = "completed";
  } else {
    plan.status = "active";
  }

  plan.updatedAt = new Date().toISOString();

  return {
    status: "success",
    action: "update_step",
    plan,
    updatedStep: step,
  };
}

// ─── Utilities (for testing) ──────────────────────────────────────

export function getPlanStore() {
  return planStore;
}

export function clearPlanStore() {
  planStore.clear();
}
