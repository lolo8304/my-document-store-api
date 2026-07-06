# my-document-store-api

NestJS REST API for indexing scanned PDFs from Dropbox and searching OCR text with
keyword and vector search.

## Setup

Copy `.env.example` into `.env` and fill in Dropbox, MongoDB, OpenAI, and API key
settings. The existing `my-document-store-key` variable is also accepted as a
legacy API key name; `MY_DOCUMENT_STORE_API_KEY` is preferred.

Dropbox access uses the same refresh-token pattern as `fcrww-api`: configure
`DROPBOX_REFRESH_TOKEN`, `DROPBOX_CLIENT_ID`, and `DROPBOX_CLIENT_SECRET`.
`DROPBOX_ACCESS_TOKEN` can be present as an initial token, but the API refreshes
it before Dropbox calls once it is expired.
For OAuth setup, temporarily enable `DROPBOX_OAUTH_SETUP_ENABLED=true`, set
`OPERATIONAL_SETUP_KEY`, and call `/dropbox/signin` with the
`operational-setup-key` header. `/dropbox/authorize` returns the raw Dropbox
tokens only behind this operational gate so they can be copied into `.env`; turn
OAuth setup off again after saving them.

PDF OCR fallback needs Poppler's `pdftoppm` command available on the machine.

```bash
npm install
npm run start:dev
```

## API

All endpoints except `GET /health` require the `api_key` header.

- `GET /swagger`
- `GET /dropbox/signin`
- `GET /dropbox/authorize?code=...`
- `GET /health`
- `GET /settings`
- `GET /admin/status`
- `GET /admin/dropbox`
- `POST /admin/sync`
- `GET /documents/search?type=query|question&q=...&page=1&pageSize=20`
- `GET /documents/:id`
- `GET /documents/:id/text`
- `GET /documents/:id/pdf-link`

PDF links are Dropbox shared links converted to direct-download URLs. Access is
still controlled by Dropbox sharing permissions.

`POST /admin/sync` starts Dropbox sync asynchronously. Sync progress is emitted
over Socket.IO using the `sync.progress` event with `current` and `total`
counts.

Dropbox scopes needed by this API include file metadata/content read access and
sharing access for shared PDF links and diagnostics.

## MongoDB Atlas Vector Search

Create a vector search index on the `documents` collection with the name from
`VECTOR_INDEX_NAME` and the vector path `embedding`. With the default OpenAI
`text-embedding-3-small` model, use `1536` dimensions. Add `deleted` as a filter
field so question search can ignore deleted documents.

Question/vector search is available only when `VECTOR_SEARCH_ENABLED=true`.
