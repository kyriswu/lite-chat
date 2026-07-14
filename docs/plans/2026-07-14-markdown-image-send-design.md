# Markdown Image Send Design

## Goal

Prevent pasted Markdown image links from being converted into multimodal image requests and causing chat requests to fail when remote image downloads are unavailable.

## Approach

Keep input Markdown as text by default. Only image references created by Lite Chat itself are sent as `image_url` parts:

- `litechat-image://` placeholders backed by locally pasted or uploaded image data
- inline `data:image/...` URLs

Regular Markdown image links, including `http://` and `https://` links, remain in the text part unchanged.

## Error Handling

The client no longer asks the server to fetch arbitrary remote Markdown image URLs. Existing server-side image normalization remains responsible for genuine image parts.

## Verification

- A pasted problem statement containing `![](http://example.com/image.png)` sends as text.
- A locally pasted or uploaded image still sends as an image part.
- Markdown rendering of user messages remains unchanged.
