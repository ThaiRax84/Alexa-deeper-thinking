// ToolHub: one place where the agent finds its tools, whether they come from an MCP
// server (e.g. the calendar) or are implemented locally (e.g. web search).
//
// Confirmation policy lives here, outside the model: any tool marked destructive
// (MCP annotation destructiveHint) is never executed by the agent loop on its own.
// The voice layer must ask the user and call executeConfirmed() after a clear "yes".

const MAX_RESULT_CHARS = 8000;

const mcpText = (result) =>
  (result?.content ?? [])
    .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
    .join("\n");

export class ToolHub {
  constructor() {
    /** @type {Map<string, {name, description, inputSchema, destructive, run, quickReply?}>} */
    this.tools = new Map();
  }

  /**
   * @param {{name: string, description: string, inputSchema: object, destructive?: boolean,
   *          run: (args: object, opts: {signal?: AbortSignal}) => Promise<string|object>,
   *          quickReply?: (args: object, content: string) => string|undefined}} tool
   */
  addLocal(tool) {
    this.tools.set(tool.name, { destructive: false, ...tool });
    return this;
  }

  /**
   * Registers every tool exposed by a connected MCP client.
   * @param {import("@modelcontextprotocol/sdk/client/index.js").Client} client
   * @param {{quickReplies?: Record<string, (args: object, content: string) => string|undefined>}} [opts]
   */
  async addMcp(client, { quickReplies = {} } = {}) {
    client._toolListCache ??= (await client.listTools()).tools;
    for (const t of client._toolListCache) {
      this.tools.set(t.name, {
        name: t.name,
        description: t.description ?? t.title ?? t.name,
        inputSchema: t.inputSchema ?? { type: "object", properties: {} },
        destructive: t.annotations?.destructiveHint === true,
        quickReply: quickReplies[t.name],
        run: async (args, { signal } = {}) => {
          const res = await client.callTool({ name: t.name, arguments: args }, undefined, { signal });
          if (res.isError) throw new Error(mcpText(res) || "Tool failed.");
          return mcpText(res);
        },
      });
    }
    return this;
  }

  /** Tool specs in the provider-neutral shape the adapters expect. */
  specs() {
    return [...this.tools.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }

  needsConfirmation(name) {
    return this.tools.get(name)?.destructive === true;
  }

  /** Runs a tool call; never throws. Destructive tools are refused unless confirmed. */
  async call({ id, name, args }, { signal, confirmed = false } = {}) {
    const tool = this.tools.get(name);
    const result = (content, isError = false) => ({ id, name, content: content.slice(0, MAX_RESULT_CHARS), isError });
    if (!tool) return result(`Unknown tool: ${name}`, true);
    if (tool.destructive && !confirmed) return result("This action needs the user's explicit confirmation.", true);
    try {
      const out = await tool.run(args ?? {}, { signal });
      return result(typeof out === "string" ? out : JSON.stringify(out));
    } catch (e) {
      return result(String(e?.message ?? e), true);
    }
  }

  /** Runs a call the user has explicitly confirmed by voice. */
  executeConfirmed(call, opts = {}) {
    return this.call({ id: "confirmed", ...call }, { ...opts, confirmed: true });
  }

  /**
   * A spoken reply built from tool results without another model round-trip, when
   * every call in the step succeeded and has a quick-reply template.
   */
  quickReply(calls, results) {
    const phrases = [];
    for (let i = 0; i < calls.length; i++) {
      const tool = this.tools.get(calls[i].name);
      if (!tool?.quickReply || results[i].isError) return undefined;
      const phrase = tool.quickReply(calls[i].args ?? {}, results[i].content);
      if (!phrase) return undefined;
      phrases.push(phrase);
    }
    return phrases.length ? phrases.join(" ") : undefined;
  }
}
