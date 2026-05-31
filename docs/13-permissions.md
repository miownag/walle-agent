# 13 — Permissions & Security

## 设计原则

1. 每个 Tool 声明自己的风险等级
2. PermissionPolicy 定义全局策略
3. 高风险操作需要审批（可对接 UI 或回调函数）
4. 权限检查是同步的，不阻塞 streaming

---

## PermissionPolicy

```ts
export interface PermissionPolicy {
  /** 全局模式 */
  mode: "auto" | "ask" | "deny-high-risk";

  /** 白名单：这些工具总是允许 */
  allowTools?: string[];

  /** 黑名单：这些工具总是禁止 */
  denyTools?: string[];

  /** 需要审批的条件 */
  requireApprovalFor?: {
    riskLevel?: Array<"medium" | "high">;
    toolNames?: string[];
    /** 文件写入操作 */
    fileWrite?: boolean;
    /** 网络请求 */
    network?: boolean;
    /** Shell 命令 */
    shell?: boolean;
  };

  /** 审批回调（返回 true 则通过） */
  approvalHandler?: (request: ApprovalRequest) => Promise<boolean>;
}
```

---

## ApprovalRequest

```ts
export interface ApprovalRequest {
  /** 请求审批的工具 */
  tool: Tool;

  /** 具体调用参数 */
  call: ModelToolCall;

  /** 风险等级 */
  riskLevel: "low" | "medium" | "high";

  /** 可读的描述 */
  description: string;
}
```

---

## PermissionDecision

```ts
export interface PermissionDecision {
  allowed: boolean;
  reason?: string;
  requiresApproval?: boolean;
}
```

---

## 权限检查逻辑

```ts
export async function checkToolPermission(
  tool: Tool,
  call: ModelToolCall,
  policy: PermissionPolicy,
): Promise<PermissionDecision> {
  // 1. 黑名单优先
  if (policy.denyTools?.includes(tool.name)) {
    return { allowed: false, reason: "Tool is denied by policy" };
  }

  // 2. 白名单直接通过
  if (policy.allowTools?.includes(tool.name)) {
    return { allowed: true };
  }

  // 3. 全局 deny-high-risk 模式
  if (policy.mode === "deny-high-risk" && tool.riskLevel === "high") {
    return { allowed: false, reason: "High-risk tool denied by policy" };
  }

  // 4. 检查是否需要审批
  const needsApproval = checkNeedsApproval(tool, policy);
  if (needsApproval) {
    if (!policy.approvalHandler) {
      // 没有审批回调，根据模式决定
      if (policy.mode === "ask") {
        return { allowed: false, reason: "Approval required but no handler", requiresApproval: true };
      }
      // auto 模式下默认通过
      return { allowed: true };
    }

    const approved = await policy.approvalHandler({
      tool,
      call,
      riskLevel: tool.riskLevel ?? "low",
      description: `Tool "${tool.name}" wants to execute with args: ${JSON.stringify(call.arguments)}`,
    });

    return {
      allowed: approved,
      reason: approved ? undefined : "Approval denied by user",
    };
  }

  // 5. 默认通过
  return { allowed: true };
}

function checkNeedsApproval(tool: Tool, policy: PermissionPolicy): boolean {
  const req = policy.requireApprovalFor;
  if (!req) return false;

  // 工具自身声明需要审批
  if (tool.requiresApproval) return true;

  // 按风险等级
  if (req.riskLevel?.includes(tool.riskLevel as any)) return true;

  // 按工具名
  if (req.toolNames?.includes(tool.name)) return true;

  // 按标签
  if (req.fileWrite && tool.tags?.includes("file-write")) return true;
  if (req.network && tool.tags?.includes("network")) return true;
  if (req.shell && tool.tags?.includes("shell")) return true;

  return false;
}
```

---

## Approval Handler 示例

### CLI 交互式审批

```ts
import * as readline from "node:readline/promises";

const cliApprovalHandler = async (request: ApprovalRequest): Promise<boolean> => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(`\n⚠️  Approval required:`);
  console.log(`   Tool: ${request.tool.name}`);
  console.log(`   Risk: ${request.riskLevel}`);
  console.log(`   Args: ${JSON.stringify(request.call.arguments, null, 2)}`);

  const answer = await rl.question("   Allow? (y/n): ");
  rl.close();

  return answer.toLowerCase() === "y";
};
```

### 自动审批（开发环境）

```ts
const autoApproveHandler = async (_: ApprovalRequest): Promise<boolean> => true;
```

### Webhook 审批（生产环境）

```ts
const webhookApprovalHandler = async (request: ApprovalRequest): Promise<boolean> => {
  const response = await fetch("https://my-app.com/api/agent-approval", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  const data = await response.json();
  return data.approved === true;
};
```

---

## 使用示例

```ts
const agent = await Agent.create({
  name: "Secure-Agent",
  model: provider,
  permissions: {
    mode: "ask",
    allowTools: ["web_search", "calculator"],
    denyTools: ["rm_rf"],
    requireApprovalFor: {
      riskLevel: ["high"],
      shell: true,
      fileWrite: true,
    },
    approvalHandler: cliApprovalHandler,
  },
});
```

---

## 安全最佳实践

1. **最小权限**：默认 `deny-high-risk`，显式允许需要的工具
2. **审批不阻塞**：审批回调应有超时机制，避免 Agent 永远挂起
3. **日志审计**：所有权限决策（尤其是 denied/approved）写入 Trace
4. **Sandbox 配合**：即使通过权限检查，高风险工具仍应在 Sandbox 中执行
5. **参数校验**：Tool 的 `execute` 内部应再做一次输入验证
