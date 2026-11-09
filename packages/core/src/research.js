// Web tools backed by the Tavily API. The operator provides one key for all users,
// so users configure nothing.

const TAVILY = "https://api.tavily.com";

async function tavily(fetchImpl, apiKey, path, body, signal) {
  const res = await fetchImpl(`${TAVILY}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`Web request failed (HTTP ${res.status}).`);
  return res.json();
}

export function webSearchTool({ apiKey, fetchImpl = fetch, maxResults = 5, depth = "basic" }) {
  return {
    name: "web_search",
    description:
      "Searches the web for current information. Returns a short answer and the top results with their URLs.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"],
    },
    async run({ query }, { signal } = {}) {
      const data = await tavily(
        fetchImpl,
        apiKey,
        "/search",
        { query: String(query).slice(0, 400), max_results: maxResults, search_depth: depth, include_answer: true },
        signal
      );
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

export function readPageTool({ apiKey, fetchImpl = fetch, maxChars = 12_000 }) {
  return {
    name: "read_page",
    description: "Reads the main text of a web page found with web_search, to check details and quotes.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "http(s) URL" } },
      required: ["url"],
    },
    async run({ url }, { signal } = {}) {
      const u = new URL(String(url));
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Only http(s) URLs can be read.");
      const data = await tavily(fetchImpl, apiKey, "/extract", { urls: [u.href] }, signal);
      const page = data.results?.[0];
      if (!page) throw new Error("The page could not be read.");
      return { url: page.url, content: String(page.raw_content ?? "").slice(0, maxChars) };
    },
  };
}
