import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { deriveSources, sanitizeSearchResults, titleFromUrl } from "./results.ts";
import type { SearchResultDetail, Source, StreamResult } from "./types.ts";

export type DeepSeekRequest = <T>(operation: "search" | "fetch", body: Record<string, unknown>, signal?: AbortSignal) => Promise<T>;

// DeepSeek documents `count` as 1–50 and bills per request, so stop at its
// default instead of spending the full range on every call.
const SEARCH_RESULT_LIMIT = 10;
const SNIPPET_LIMIT = 2000;
const FETCH_CONTENT_LIMIT = 8000;

// Only the fields this module reads; the whole payload is kept on `raw`, which
// is where `rerank_score` and `authority` stay available to callers.
interface DeepSeekSearchResult {
    title?: string;
    url?: string;
    snippet?: string;
    summary?: string;
    site_name?: string | null;
    date?: string | null;
}

interface DeepSeekFetchResult {
    title?: string;
    content?: string;
}

/**
 * Keep the page content exactly as the API documents it ("content as Markdown
 * text"); only guard against a missing or oversized body.
 */
function truncateContent(text: string | undefined, limit = FETCH_CONTENT_LIMIT): string {
    const trimmed = (text || "").trim();
    return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

function firstNonEmpty(...values: Array<string | null | undefined>): string {
    for (const value of values) {
        const trimmed = typeof value === "string" ? value.trim() : "";
        if (trimmed) return trimmed;
    }
    return "";
}

/** URL metadata in the same shape Gemini's url_context produces downstream. */
function toUrlContextMetadata(pages: Array<{ url: string; ok: boolean }>) {
    return {
        urlMetadata: pages.map((page) => ({
            retrievedUrl: page.url,
            urlRetrievalStatus: page.ok ? "URL_RETRIEVAL_STATUS_SUCCESS" : "URL_RETRIEVAL_STATUS_ERROR",
        })),
    };
}

function formatHit(hit: DeepSeekSearchResult, index: number): string {
    const title = hit.title || titleFromUrl(hit.url || "");
    const lines = [`## ${index + 1}. ${title}`];
    if (hit.url) lines.push(hit.url);
    const meta = [hit.site_name, hit.date].filter(Boolean).join(" · ");
    if (meta) lines.push(meta);
    // `summary` supersedes `snippet` when present: DeepSeek documents it as the
    // model-facing text, while `snippet` is display text.
    const body = firstNonEmpty(hit.summary, hit.snippet);
    // Blank line keeps a Markdown heading in the summary from being swallowed by
    // the metadata line above it.
    if (body) lines.push("", truncateContent(body, SNIPPET_LIMIT));
    return lines.join("\n");
}

type FetchedPage =
    | { url: string; ok: true; title?: string; content: string }
    | { url: string; ok: false; status: string };

async function fetchPages(
    request: DeepSeekRequest,
    urls: string[],
    signal: AbortSignal | undefined,
    reportFetchErrors: boolean,
): Promise<FetchedPage[]> {
    const pages: FetchedPage[] = [];
    for (const url of urls) {
        signal?.throwIfAborted();
        try {
            const data = await request<DeepSeekFetchResult>("fetch", { url }, signal);
            signal?.throwIfAborted();
            const content = truncateContent(data.content);
            if (!content) throw new Error("Page fetch returned no extractable content");
            pages.push({ url, title: data.title || undefined, content, ok: true });
        } catch (error) {
            signal?.throwIfAborted();
            if (!reportFetchErrors) throw error;
            pages.push({ url, ok: false, status: error instanceof Error ? error.message : String(error) });
        }
    }
    return pages;
}

function pushSource(sources: Source[], source: Source) {
    if (!sources.some((existing) => existing.url === source.url)) sources.push(source);
}

export async function searchDeepSeek(
    request: DeepSeekRequest,
    query: string,
    urls?: string[],
    onUpdate?: AgentToolUpdateCallback,
    signal?: AbortSignal,
    reportFetchErrors = false,
): Promise<StreamResult> {

    onUpdate?.({
        content: [{ type: "text", text: `Searching the web...` }],
        details: { streaming: true, searching: true },
    });

    // need_content=false: `content` is the full page, which would blow up the
    // tool result for little gain over `summary`. Requested URLs are fetched
    // separately through the matching fetch endpoint instead.
    const data = await request<{ results?: DeepSeekSearchResult[] }>(
        "search",
        { query, count: SEARCH_RESULT_LIMIT, need_content: false },
        signal,
    );
    // `results` is empty for a normal search with no matches, never an error.
    // URLs are what every downstream consumer keys on, so drop the rest.
    const hits = (data.results ?? []).filter((hit) => hit && typeof hit.url === "string" && hit.url);

    const searchResults: SearchResultDetail[] = hits.map((hit) => ({
        title: hit.title || titleFromUrl(hit.url!),
        url: hit.url,
        query,
        citedText: firstNonEmpty(hit.summary, hit.snippet) || undefined,
        source: "deepseek.tools.search",
        type: "search_result",
        pageAge: hit.date || undefined,
        raw: hit,
    }));
    const sources: Source[] = hits.map((hit) => ({
        title: hit.title || titleFromUrl(hit.url!),
        url: hit.url!,
    }));

    const lines = [`Search results for "${query}":`];
    if (hits.length === 0) lines.push("No results found.");
    hits.forEach((hit, i) => lines.push("", formatHit(hit, i)));

    let urlContextMetadata;
    if (urls?.length) {
        onUpdate?.({
            content: [{ type: "text", text: `Fetching ${urls.length} URL(s)...` }],
            details: { streaming: true },
        });
        const pages = await fetchPages(request, urls, signal, reportFetchErrors);
        urlContextMetadata = toUrlContextMetadata(pages);
        for (const page of pages) {
            if (!page.ok) {
                lines.push("", `## Fetch failed: ${page.url}`, page.status || "Unknown error");
                continue;
            }
            lines.push("", `## Fetched: ${page.title || page.url}`, page.url, "", page.content);
            pushSource(sources, { title: page.title || titleFromUrl(page.url), url: page.url });
            searchResults.push({
                title: page.title || titleFromUrl(page.url),
                url: page.url,
                citedText: page.content,
                source: "deepseek.tools.fetch",
                type: "fetched_page",
                raw: page,
            });
        }
    }

    const sanitizedSearchResults = sanitizeSearchResults(searchResults);

    return {
        text: lines.join("\n"),
        sources: sources.length ? sources : deriveSources(sanitizedSearchResults),
        providerKind: "deepseek",
        // No streaming events exist on this path; nativeSearchUsed still marks
        // that DeepSeek's own search engine answered, matching the Ollama shape.
        nativeSearchUsed: true,
        searchQueries: [query],
        searchResults: sanitizedSearchResults,
        urlContextMetadata,
    };
}

/** url_context for DeepSeek: fetch each URL through the fetch endpoint, no model involved. */
export async function fetchDeepSeek(
    request: DeepSeekRequest,
    query: string,
    urls: string[],
    signal?: AbortSignal,
    reportFetchErrors = false,
): Promise<StreamResult> {
    const pages = await fetchPages(request, urls, signal, reportFetchErrors);

    const lines = [`URL contents for: ${query}`];
    const sources: Source[] = [];
    const searchResults: SearchResultDetail[] = [];
    for (const page of pages) {
        if (!page.ok) {
            lines.push("", `## Failed: ${page.url}`, page.status || "Unknown error");
            continue;
        }
        lines.push("", `## ${page.title || page.url}`, page.url, "", page.content);
        pushSource(sources, { title: page.title || titleFromUrl(page.url), url: page.url });
        searchResults.push({
            title: page.title || titleFromUrl(page.url),
            url: page.url,
            citedText: page.content,
            source: "deepseek.tools.fetch",
            type: "fetched_page",
            raw: page,
        });
    }

    return {
        text: lines.join("\n"),
        sources,
        providerKind: "deepseek",
        nativeSearchUsed: false,
        searchResults: sanitizeSearchResults(searchResults),
        urlContextMetadata: toUrlContextMetadata(pages),
    };
}
