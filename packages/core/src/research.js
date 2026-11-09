// Web search tool for quick questions, backed by the Tavily Search API.
// The operator provides one key for all users, so users configure nothing.

export function webSearchTool({ apiKey, fetchImpl = fetch, maxResults = 5 }) {
  return {
    name: "web_search",
    description:
      "Searches the web for current information. Use it for quick questions that need recent or factual data.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"],
    },
    async run({ query }, { signal } = {}) {
      const res = await fetchImpl("https://api.tavily.com/search", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ query: String(query).slice(0, 400), max_results: maxResults, include_answer: true }),
        signal,
      });
      if (!res.ok) throw new Error(`Web search failed (HTTP ${res.status}).`);
      const data = await res.json();
      return {
        answer: data.answer,
        results: (data.results ?? []).map((r) => ({
          title: r.title,
          url: r.url,
          content: String(r.content ?? "").slice(0, 600),
        })),
      };
    },
  };
}
