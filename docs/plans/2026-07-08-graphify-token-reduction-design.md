# Graphify Token Reduction Design

## Goal

Use Graphify as a query-first knowledge layer for this repository so AI assistants stop rereading the whole codebase and instead retrieve only the smallest relevant subgraph. The objective is lower context usage, faster codebase navigation, and more consistent cross-file reasoning.

## Recommended Approach

Adopt the repository-level Graphify workflow as the default. Build a graph for the current project, keep the generated `graphify-out/` artifacts available for reuse, and bias all assistant-facing workflows toward `graphify query`, `graphify path`, and `graphify explain` before reading source files directly.

This repo is a good fit for that pattern because its structure is already cleanly separated into `server.js`, `routes/`, `db/`, `middleware/`, and `public/`. Those boundaries map naturally to graph nodes and dependencies, which makes targeted retrieval practical.

## Scope

Keep the graph focused on high-signal sources:

- Application entrypoints and route handlers
- Database schema and migration logic
- Middleware and authentication paths
- Static UI files that contain behavior or routing logic
- Documentation that explains architecture or operational behavior

Exclude low-value or high-churn paths:

- `node_modules/`
- runtime uploads and generated assets
- build outputs and caches
- local dependency or lock artifacts that do not help reasoning

## Workflow

1. Build the graph once for the repository.
2. Use the graph as the first lookup step for codebase questions.
3. Only read raw files after a graph query identifies the relevant files or symbols.
4. Refresh the graph incrementally when source changes.
5. Keep `graphify-out/` available so the team can reuse the same index instead of rebuilding context from scratch.

## Why This Reduces Tokens

The savings come from avoiding repeated full-file or full-repo reads. Graphify turns the repository into a compact structure with explicit relationships, so the assistant can answer questions from a small subgraph instead of loading many unrelated files. That matters most for cross-file questions such as authentication flows, message routing, database initialization, and admin behavior.

## Risks

- Over-aggressive ignore rules could omit useful context.
- If assistants are not instructed to consult the graph first, token savings will be inconsistent.
- If generated graph artifacts are not kept current, answers may drift from the source.

## Validation

Use a small repeatable comparison:

1. Ask three representative questions about login flow, message routing, and database setup.
2. Answer each once by reading files directly and once using Graphify queries.
3. Compare token usage, number of files touched, and answer quality.
4. Update ignore rules or graph refresh cadence if the graph path is missing key context.

## Next Step

If this design is accepted for implementation, add the Graphify workflow notes and ignore rules to the repository, then wire the assistant instructions so graph queries happen before file reads.