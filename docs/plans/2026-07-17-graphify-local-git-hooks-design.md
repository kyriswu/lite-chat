# Graphify Local Git Hooks Design

## Goal

Keep the local Graphify knowledge graph fresh without slowing down commits or
requiring generated graph artifacts to be committed.

## Scope

Install two hooks in the local `.git/hooks/` directory. They are intentionally
not versioned, so each clone or development machine must install them again.

## Design

- Keep the existing VS Code save trigger for fast incremental updates:
  `graphify update . --no-cluster`.
- A `post-commit` hook checks whether the new commit contains files under
  `graphify-out/`. If it does not, it starts a background full rebuild with
  `graphify .`.
- A `post-checkout` hook starts a background full rebuild only when the checked
  out branch already contains `graphify-out/graph.json`.
- `GRAPHIFY_SKIP_HOOK=1` disables either hook for a one-off Git operation.
- Hooks test that `graphify` is installed, redirect output to
  `~/.cache/graphify/rebuild.log`, and always exit successfully. A graph rebuild
  must never prevent a commit or branch checkout.

## Alternatives Considered

- Synchronous hooks would guarantee freshness at the end of a Git operation but
  noticeably delay commits and checkouts.
- A `post-push` hook would avoid local work during commits but leaves the local
  graph stale for longer.

The selected asynchronous `post-commit` plus `post-checkout` mechanism keeps
the graph current while preserving normal Git responsiveness.
