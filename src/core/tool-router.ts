import type { ToolCall, ToolDefinition } from './providers/llm.js';

type RegisteredTool = {
  definition: ToolDefinition;
  handler: ToolHandler;
};

export type ToolHandler = (
  args: Record<string, unknown>,
) => Promise<string>;

export class ToolRouter {
  private readonly tools: Map<string, RegisteredTool>;

  public constructor() {
    this.tools = new Map<string, RegisteredTool>();
  }

  public register(definition: ToolDefinition, handler: ToolHandler): void {
    this.tools.set(definition.name, { definition, handler });
  }

  public unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  public getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values(), ({ definition }) => definition);
  }

  public async execute(toolCall: ToolCall): Promise<string> {
    const tool = this.tools.get(toolCall.name);

    if (tool === undefined) {
      return JSON.stringify({
        error: `Unknown tool: ${toolCall.name}`,
      });
    }

    try {
      return await tool.handler(toolCall.arguments);
    } catch (error: unknown) {
      return JSON.stringify({
        error: this.getErrorMessage(error),
      });
    }
  }

  public has(name: string): boolean {
    return this.tools.has(name);
  }

  public get size(): number {
    return this.tools.size;
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return 'Tool execution failed';
  }
}
