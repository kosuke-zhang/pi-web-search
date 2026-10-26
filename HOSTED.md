# Hosted DeepSeek integration

Based on upstream main **97f182ad9af942d00505a138331465258739a515** (2026-10-19),
including PR #43's Search & Fetch support. The npm 1.7.0 release points at
4277d3f3be5d2a2b6de911eec730516d14bc4084 and does not contain that change.
The local version `1.7.0-tifenxia.2` identifies this adapted source, not an npm release.

Import `createHostedDeepSeekExtension` from `pi-web-search/hosted` into a Pi 1.3
SDK session. Supply a per-session `request` callback. It receives callId,
operation (`search` or `fetch`), body and an AbortSignal, and returns parsed JSON.
The host owns credentials, endpoint configuration, authorization, persisted
per-request budgets, timeouts, response limits and cancellation. Never silently
retry a paid request. Every URL is a separate request.

The factory registers `web_search` and `url_context` without CLI settings,
model discovery, global authentication or mutation of global fetch. DeepSeek
search is independent of the conversation model and does not call completions.

Adaptations: upstream DeepSeek result parsing/formatting was extracted into
`providers/deepseek-client.ts`, shared by the CLI wrapper and hosted entrypoint.
Fetches execute sequentially. The hosted entry propagates failures/cancellation
(including host budget errors); the CLI retains its explicit per-URL failure
reporting. Hosted
inputs limit search to 128 nonblank characters, at most three URLs of 2048
characters each. Tool text is capped at 32,000 characters; raw provider objects
are omitted from checkpoint details. The host validates API responses before
returning them. The CLI entrypoint retains upstream's own SDK version dependency;
only the hosted entrypoint is built and checked against Pi 1.3 here.

Build: `npm ci --ignore-scripts && npm run build:hosted`.
Package: `npm pack --pack-destination <serverx>/student_assistant/pi/vendor`.

Model-facing descriptions, generated headings and progress use provider-neutral language. Hosted failures retain a private cause but expose only a fixed operational message; cancellation still propagates. Source text and citation URLs are unchanged, even when a public article discusses an AI provider. Hosted details contain sources only.
