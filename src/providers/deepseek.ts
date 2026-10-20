import type { ExtensionContext, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAuth, type ResolvedAuth } from "./auth.ts";
import { searchDeepSeek, fetchDeepSeek } from "./deepseek-client.ts";
import type { StreamResult } from "./types.ts";

/**
 * DeepSeek exposes web search two ways: a server-side `web_search` tool on the
 * Responses API (deepseek-v4-pro only), and the standalone Search & Fetch
 * endpoints used here:
 *   POST {root}/v1/tools/search and POST {root}/v1/tools/fetch
 * This module drives the REST pair deliberately: it is model-independent (any
 * key works, including models that cannot call the server-side tool), takes an
 * explicit result count and query operators, and returns ranked results in a
 * single call without a model completion.
 */

/**
 * Strip any OpenAI-compatible or Anthropic-compatible suffix so the
 * `/v1/tools/*` endpoints resolve on the API root. Preserve a configured proxy
 * origin/path instead of sending its credentials to api.deepseek.com.
 */
export function resolveDeepSeekApiRoot(model: Model<Api>, auth?: Extract<ResolvedAuth, { ok: true }>): string {
    const base = ((auth?.baseUrl || model.baseUrl || "https://api.deepseek.com")).replace(/\/+$/, "");
    return base.replace(/\/(?:anthropic|v\d+)(?:\/v\d+)?$/i, "");
}

/** DeepSeek errors follow the OpenAI-compatible `{ error: { message, code } }` shape. */
async function deepSeekError(response: Response, label: "search" | "fetch"): Promise<Error> {
    const text = await response.text().catch(() => "");
    let message = "";
    try {
        message = JSON.parse(text)?.error?.message || "";
    } catch {
        // Fall back to the raw body below.
    }
    const detail = message || text.trim() || response.statusText;

    if (response.status === 401) {
        return new Error("No DeepSeek API key found. Run /login in pi and select DeepSeek, or set DEEPSEEK_API_KEY.");
    }
    if (response.status === 402) {
        return new Error(`DeepSeek ${label} failed: insufficient account balance. Top up the DeepSeek account and retry.`);
    }
    if (response.status === 403) {
        return new Error(`DeepSeek ${label} was rejected by the security policy: ${detail}`);
    }
    if (response.status === 404 && label === "fetch") {
        return new Error(`DeepSeek fetch could not retrieve usable page content: ${detail}`);
    }
    if (response.status === 429) {
        return new Error(`DeepSeek ${label} rate limit exceeded (5 QPS per account). Wait and retry: ${detail}`);
    }
    return new Error(`DeepSeek ${label} error (${response.status}): ${detail}`);
}

async function deepSeekPost<T>(
    root: string,
    path: string,
    body: unknown,
    headers: Record<string, string>,
    signal?: AbortSignal,
): Promise<T> {
    const response = await fetch(`${root}${path}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            ...headers,
        },
        body: JSON.stringify(body),
        signal,
    });
    if (!response.ok) throw await deepSeekError(response, path.endsWith("/fetch") ? "fetch" : "search");
    return (await response.json()) as T;
}

async function resolveDeepSeekTarget(
    ctx: ExtensionContext,
    model: Model<Api>,
): Promise<{ root: string; headers: Record<string, string> }> {
    const auth = await getAuth(ctx, model);
    if (!auth.ok) throw new Error(auth.error || "Failed to resolve DeepSeek credentials");

    const headers: Record<string, string> = { ...(model.headers || {}), ...(auth.headers || {}) };
    const hasAuth = Object.entries(headers).some(([name, value]) =>
        value && ["authorization", "x-api-key"].includes(name.toLowerCase()));
    const apiKey = auth.apiKey || process.env.DEEPSEEK_API_KEY;
    if (!hasAuth && apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (!hasAuth && !apiKey) {
        throw new Error("No DeepSeek API key found. Run /login in pi and select DeepSeek, or set DEEPSEEK_API_KEY.");
    }

    return { root: resolveDeepSeekApiRoot(model, auth), headers };
}

export async function callDeepSeekSearch(ctx: ExtensionContext, model: Model<Api>, query: string,
    urls?: string[], onUpdate?: AgentToolUpdateCallback, signal?: AbortSignal): Promise<StreamResult> {
    const { root, headers } = await resolveDeepSeekTarget(ctx, model);
    return searchDeepSeek((operation, body, signal) => deepSeekPost(root, `/v1/tools/${operation}`, body, headers, signal), query, urls, onUpdate, signal, true);
}

export async function callDeepSeekUrlContext(ctx: ExtensionContext, model: Model<Api>, query: string,
    urls: string[], signal?: AbortSignal): Promise<StreamResult> {
    const { root, headers } = await resolveDeepSeekTarget(ctx, model);
    return fetchDeepSeek((operation, body, signal) => deepSeekPost(root, `/v1/tools/${operation}`, body, headers, signal), query, urls, signal, true);
}
