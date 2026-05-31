/**
 * WallePlugin interface — unified plugin contract.
 */

import type { AgentContext } from "./agent-context.js";

export interface WallePlugin {
  name: string;
  version?: string;

  /**
   * Plugin initialization, called during Agent.create().
   * Can register tools, hooks, middleware.
   */
  install(ctx: AgentContext): Promise<void> | void;

  /**
   * Plugin disposal, called during agent.dispose().
   */
  dispose?(): Promise<void> | void;
}
