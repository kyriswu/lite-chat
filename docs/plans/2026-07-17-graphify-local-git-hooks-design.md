# Graphify Local Git Hooks Design

## Goal

Keep the local Graphify knowledge graph fresh without slowing down commits or
requiring generated graph artifacts to be committed.

## Scope

Install Graphify's two hooks in the local `.git/hooks/` directory with
`graphify hook install`. They are intentionally not versioned, so each clone or
development machine must install them again.

## Design

- Keep the existing VS Code save trigger for fast incremental updates:
  `graphify update . --no-cluster`.
- A `post-commit` hook ignores graph-only commits and Git operations in progress,
  then starts Graphify's background rebuild for the files changed by the commit.
- A `post-checkout` hook starts Graphify's background code-graph rebuild only
  after a branch switch and only when `graphify-out/` already exists.
- `GRAPHIFY_SKIP_HOOK=1` disables either hook for a one-off Git operation.
- Hooks locate Graphify's Python environment, redirect output to
  `~/.cache/graphify-rebuild.log`, and detach the rebuild. A graph rebuild must
  never prevent a commit or branch checkout.
- The installer also registers Graphify's merge driver for
  `graphify-out/graph.json`; this has no effect while the directory remains
  ignored, but supports a future decision to track graph artifacts.

## Alternatives Considered

- Synchronous hooks would guarantee freshness at the end of a Git operation but
  noticeably delay commits and checkouts.
- A `post-push` hook would avoid local work during commits but leaves the local
  graph stale for longer.

The selected asynchronous `post-commit` plus `post-checkout` mechanism keeps
the code graph current while preserving normal Git responsiveness.
