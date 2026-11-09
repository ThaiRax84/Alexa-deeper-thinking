// Small HTTP helpers shared by the providers. Error messages never include request
// headers or bodies, so API keys cannot leak into logs or spoken responses.

export class ProviderError extends Error {
  /** @param {"auth"|"rate_limit"|"bad_request"|"unavailable"|"timeout"} kind */
  constructor(kind, message, status) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.status = status;
  }
}

export const isAbort = (e) => e?.name === "AbortError" || e?.name === "TimeoutError" || e?.kind === "timeout";

function kindFor(status) {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status >= 400 && status < 500) return "bad_request";
  return "unavailable";
}

async function request(fetchImpl, url, init) {
  let res;
  try {
    res = await fetchImpl(url, init);
  } catch (e) {
    if (isAbort(e)) throw new ProviderError("timeout", "The AI provider did not answer in time.");
    throw new ProviderError("unavailable", "Could not reach the AI provider.");
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new ProviderError(kindFor(res.status), `AI provider error (HTTP ${res.status}): ${detail}`, res.status);
  }
  return res.json();
}

export const postJson = (fetchImpl, url, headers, body, signal) =>
  request(fetchImpl, url, { method: "POST", headers, body: JSON.stringify(body), signal });

export const getJson = (fetchImpl, url, headers, signal) => request(fetchImpl, url, { method: "GET", headers, signal });
