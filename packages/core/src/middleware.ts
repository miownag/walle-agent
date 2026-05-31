/**
 * Middleware system — chain-style transforms for input/output.
 */

import type { ModelMessage } from "./message.js";
import type { AgentInput, AgentResult } from "./agent-config.js";

// ─── Middleware Interface ──────────────────────────────────────────

export interface Middleware {
  name: string;
  /** Transform input before processing */
  beforeInput?(input: AgentInput, next: () => Promise<AgentInput>): Promise<AgentInput>;
  /** Transform messages before LLM call */
  beforeModel?(messages: ModelMessage[], next: () => Promise<ModelMessage[]>): Promise<ModelMessage[]>;
  /** Transform output after processing */
  afterOutput?(result: AgentResult, next: () => Promise<AgentResult>): Promise<AgentResult>;
}

// ─── MiddlewarePipeline ────────────────────────────────────────────

export class MiddlewarePipeline {
  private middlewares: Middleware[] = [];

  use(middleware: Middleware): void {
    this.middlewares.push(middleware);
  }

  async beforeInput(input: AgentInput): Promise<AgentInput> {
    return this.compose("beforeInput", input);
  }

  async beforeModel(messages: ModelMessage[]): Promise<ModelMessage[]> {
    return this.compose("beforeModel", messages);
  }

  async afterOutput(result: AgentResult): Promise<AgentResult> {
    return this.composeReverse("afterOutput", result);
  }

  private async compose<T>(method: string, initial: T): Promise<T> {
    let index = -1;

    const dispatch = async (i: number, current: T): Promise<T> => {
      if (i <= index) throw new Error("next() called multiple times");
      index = i;

      if (i >= this.middlewares.length) return current;

      const mw = this.middlewares[i];
      const handler = (mw as any)[method];

      if (!handler) return dispatch(i + 1, current);

      return handler.call(mw, current, () => dispatch(i + 1, current));
    };

    return dispatch(0, initial);
  }

  private async composeReverse<T>(method: string, initial: T): Promise<T> {
    let current = initial;

    for (let i = this.middlewares.length - 1; i >= 0; i--) {
      const mw = this.middlewares[i];
      const handler = (mw as any)[method];
      if (handler) {
        current = await handler.call(mw, current, async () => current);
      }
    }

    return current;
  }
}
