# Instagram connector for KIAgent

Indexes your Instagram **direct messages** into your local KIAgent digital
memory via the Instagram Graph API. One chat-day document per conversation per
local-time day, plus photo/PDF attachments as OCR-able file documents.

Built for the v2 KIAgent extension platform: a self-contained CJS bundle the
host loads out-of-process, with declared capabilities (`net`, `query`) instead
of raw host access. No runtime npm dependencies. Authentication is a pasted
**long-lived access token** from a Meta app you create yourself — stored in the
platform's encrypted vault, never in connector state or config.

## Install

1. Open **Add a source → Browse the marketplace** (or the Marketplace screen).
2. Find **Instagram** under the official store and click **Install**.
3. Review the requested capabilities (`net`, `query`) and confirm.

Or install straight from a published GitHub release: paste the release's
`.tgz` URL and its integrity hash into KIAgent's "Install from URL" dialog.

## Connect an account

1. Create a Meta app at <https://developers.facebook.com/docs/instagram-platform>
   and generate a **long-lived access token** with read access to the account's
   profile and messages.
2. Paste the token into the connect prompt. The connector validates it with a
   live `GET /me` call before the account is created; the token then rides the
   platform vault (encrypted at rest). Multiple accounts are supported.

If the token expires or is revoked, the account flips to *needs reauth* —
reconnect with a fresh token.

## What it indexes

- One `instagram.chat_day` document per conversation per local-time day
  (`**<sender>** (HH:MM): <text>` lines; deep link back to the thread).
- Photos and PDFs from messages as `file` documents (≤ 25 MiB), parented to
  their chat-day. Bytes are downloaded **eagerly during each poll** because
  the Graph API's CDN URLs are signed and short-lived; the platform's local
  OCR/vision pipeline extracts their text. Videos/audio stay text
  placeholders (`[video]` / `[audio]`).
- Metadata: thread id/name, participants, message timestamps, and the full
  per-day message ledger.

### The ~20-message window, and why history survives

The Graph API exposes **no pagination** for DM history: each poll sees only
the last ~20 messages per thread. The connector therefore:

- polls every 15 minutes (default cadence) and only re-reads threads whose
  `updated_time` advanced past the account cursor;
- **merges** each fetched window with the message ledger already stored on the
  day document (union by message id), so messages that scroll out of the API
  window are never lost from the rendered day.

There is no backfill phase — the first sweep simply ingests everything the
API currently returns. Deleted upstream messages are not detected (the API
lists no deletions), so nothing is ever auto-archived.

## Changes from v1 (1.x)

- Ported to the v2 extension platform: engine-owned accounts, vault, retries
  between polls, storage, and OCR enrollment. The v1 host files (account
  SQL, safeStorage token blobs, media byte cache + sweep) are gone.
- Document type renamed `instagram_chat_day` → `instagram.chat_day`.
- Auth errors (HTTP 401 / Graph code 190) are now detected and surface as
  *needs reauth* instead of being retried blindly.
- **Dropped: the "Import export…" action** (ingesting a Download Your
  Information folder, and the `files:read` permission it needed). Live
  polling is the only ingestion path in 2.0.0.

## Trust model

This extension runs in the host's extension child process with only the
capabilities you grant at install time: `net` (Graph API + media CDN fetches)
and `query` (read-only lookups of its own documents, used for the chat-day
merge and media dedupe). Everything it writes stays in your local KIAgent
store. The source is here for audit.

## Build from source

```bash
npm install
npm run typecheck
npm test
npm run build        # → dist/index.js (self-contained CJS bundle)
npm pack             # → instagram-kia-connector-<version>.tgz
```

## Releasing a new version

1. Bump `version` in **both** `package.json` and `manifest.json` (must match).
2. `npm install` (if deps changed) → `npm test` → `npm run build` → `npm pack`.
3. Compute the integrity hash:
   ```bash
   openssl dgst -sha512 -binary instagram-kia-connector-<version>.tgz \
     | { printf 'sha512-'; base64; }
   ```
4. Publish the GitHub release with the tarball as an asset:
   ```bash
   gh release create v<version> instagram-kia-connector-<version>.tgz \
     --title "v<version>" --notes "Integrity: sha512-…"
   ```

Released assets are immutable — never mutate an existing release; behavior
changes require a version bump.

## License

MIT — see [LICENSE](./LICENSE).
