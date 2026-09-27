# ORION

A research workspace with planning, tool execution, persistent context, and evaluation. Gemini fills separate analyst, decision-controller, specialist, moderator, evaluator, and writer roles. LangGraph coordinates the workflow; LangChain handles prompts, structured output, and retrieval.

## Workflow

Goal → analyze → retrieve memory → plan → decide → execute → observe → evaluate → improve → report.

The JEV-style JSON controller selects permitted actions and two distinct specialists. Specialists run sequentially; a moderator reconciles their findings and uncertainties. This is application-level orchestration using one configured model, not the proprietary TypeSafe JEV model.

SQLite stores tasks, events, document chunks, and normalized embedding vectors. Server-Sent Events replay saved progress after reconnecting. Clarification, cancellation, bounded retries, and run limits control execution.

## Setup

Requires Node.js 22.13+ or 24.

```powershell
Copy-Item .env.example .env
npm ci
npm run dev
```

Set GEMINI_API_KEY in the local .env file. Open http://127.0.0.1:5173. Keep credentials server-side and never commit .env.

For a production build:

```sh
npm run build
npm start
```

The local production server listens on http://127.0.0.1:4317.

## Research settings

The default model is gemini-3.5-flash-lite. The default RESEARCH_MODE=documents uses imported references and disables Google Search grounding. Import a TXT, Markdown, CSV, or text-based PDF before document research. Scanned PDFs are unsupported.

Example goal: Using the imported reference, compare the proposed study plans. Have an Evidence Analyst and Skeptic examine the evidence and uncertainties, then save recommendation.md. Use only the supplied reference.

The interface displays analysis, plans, actions, specialist messages, evaluation, and downloadable reports. Embeddings use gemini-embedding-001 with normalized 768-dimensional vectors. Retrieval similarity measures relevance, not factual certainty.

Requests share one queue with 15 seconds between starts, configured with GEMINI_MIN_INTERVAL_MS. Quota errors stop remaining specialist calls; temporary server errors retry twice with exponential backoff. These controls reduce bursts but cannot guarantee available quota. Model selection does not disable billing on a paid project.

## Replit

Import this repository into a Node.js app. The included .replit file provides build, run, and port settings.

1. Add GEMINI_API_KEY and DEMO_PASSWORD in Replit Secrets.
2. Click Run.
3. Sign in with username demo and the configured password.
4. Publish a single-instance deployment: build command `npm ci && npm run build`; run command `npm start`.

Public binding uses HOST=0.0.0.0 and requires a demo password. History and uploads use local disk; durable history requires persistent storage. Do not run multiple replicas against independent SQLite files. Hosting charges are separate from API quotas.

## Checks

```sh
npm test
npm run typecheck
npm run build
```

Tests use explicit fixtures for schemas, workflow sequencing, clarification, repair loops, provider backoff, serialization, and file safety. They do not establish live provider availability. The latest replacement-model smoke request timed out; a complete live workflow and hosted deployment remain unverified.

## Data boundaries

Task goals and selected excerpts are sent to the configured provider. Hosted Python cannot read local files directly. File artifacts stay within task directories. External API operations are administrator-configured, read-only HTTPS requests. Host shell execution is unavailable.

Credentials, generated artifacts, private documentation, dependencies, build output, and task data are excluded from version control.
