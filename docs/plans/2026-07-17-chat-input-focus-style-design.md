# Chat Input Focus Style Design

## Goal

Remove the weak visual border and glow shown when the chat composer receives mouse or keyboard focus.

## Scope

- Update only the chat composer container, `#input-wrap`, in `public/index.html`.
- Leave its default border and shadow unchanged.
- Do not affect the focus styling of other form controls or any compose behavior.

## Implementation

Remove the `#input-wrap:focus-within` rule. The textarea already suppresses its own native outline, so without that wrapper rule the composer retains its normal resting appearance for both mouse focus and Tab focus.

## Verification

- Confirm the focus-within selector is absent.
- Confirm the default `#input-wrap` border and shadow declarations remain.
- Run the existing test suite if available.
