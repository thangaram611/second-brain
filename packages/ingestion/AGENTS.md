# @second-brain/ingestion — Agent Instructions

LLM extraction and embedding pipeline for auto-growing the knowledge graph.

## Entry Point

`src/index.ts` re-exports the pipeline and extraction modules.

## Key Directories

| Directory | Purpose |
|-----------|---------|
| `src/extraction/` | LLM-based entity/relation extraction from text |
| `src/pipeline/` | Orchestrates extraction → embedding → storage |
| `src/net/` | HTTP/API client helpers for LLM providers |

## Key Files

- `src/content-hash.ts` — Deduplication via content hashing (avoids re-processing)

## How It Works

1. Raw content arrives (from collectors or manual input)
2. Content is hashed for dedup (`content-hash.ts`)
3. LLM extracts entities and relations (`src/extraction/`)
4. Optionally generates embeddings for vector search
5. Results are stored via `@second-brain/core`

## Conventions

- All LLM calls go through the extraction module
- Content hashing prevents duplicate processing
- Embedding dimensions must match what `Brain` was constructed with
