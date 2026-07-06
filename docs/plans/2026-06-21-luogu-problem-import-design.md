# Luogu Problem Import Design

## Goal

Add Luogu problem import to `code-review.html` so users can:

- import a problem by URL
- paste a Luogu problem URL and have the page auto-detect and fetch it

The existing review pipeline remains text-based. Imported problems are normalized into the current `problemText` field before review.

## Recommended Approach

Use a dedicated backend importer route and keep the current review endpoints unchanged.

- Frontend:
  - add a Luogu URL input and import button
  - detect pasted Luogu links in the problem textarea and auto-import
  - replace the textarea content with normalized problem text after import
- Backend:
  - add `POST /api/code-review/import-problem`
  - only allow Luogu problem URLs
  - fetch the page HTML
  - extract `script#lentille-context`
  - parse `data.problem` JSON and convert it into review-friendly plain text

## Rejected Alternatives

### Parse visible HTML blocks

This is more brittle than consuming the embedded JSON payload and is more likely to break on layout changes.

### Browser-side direct fetch

This is weaker because of CORS and anti-bot behavior. Server-side fetch is more reliable and easier to validate.

## Data Flow

1. User pastes a Luogu URL or clicks import with a Luogu URL.
2. Frontend calls `/api/code-review/import-problem` with `{ url }`.
3. Backend validates the hostname and problem path.
4. Backend fetches the page and extracts:
   - title
   - description
   - input format
   - output format
   - hint
   - samples
   - time limit
   - memory limit
5. Backend returns:
   - normalized `problemText`
   - lightweight metadata for UI feedback
6. Frontend fills the textarea with `problemText`.
7. Existing static/deep review endpoints work as before.

## Error Handling

- Invalid hostname or unsupported path: reject with `400`
- Fetch failure: return `502`
- Missing embedded JSON or malformed payload: return `422`
- Empty extraction result: return `422`

## Security Constraints

- Restrict imports to `luogu.com.cn` and `www.luogu.com.cn`
- Only accept `/problem/<pid>` style paths
- Do not proxy arbitrary URLs
- Apply a request timeout to the upstream fetch

## Verification

- Import `https://www.luogu.com.cn/problem/P1214`
- Confirm textarea is populated with normalized text
- Confirm pasted Luogu link auto-imports
- Confirm existing review actions still operate on imported content
