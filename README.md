# Instagram connector for alpha-cent / KIAgent

Indexes your Instagram direct messages into your local KIAgent digital memory.
Two paths into the same chat-day documents: a live poll of the Instagram Graph
API, and a one-shot import of an official "Download Your Information" (DYI)
export for full history and group threads.

Self-contained, out-of-process plugin — pure Node + `fetch`, no runtime npm
dependencies, no OAuth redirect. Authentication is a pasted **long-lived access
token** from a Meta app you create yourself, encrypted at rest with the host's
safeStorage.

## Host API

Requires alpha-cent host API `^2.0.0`.

## Install

This connector is published to the official `kia-plugins` marketplace. In
KIAgent:

1. Open **Add a source → Browse the marketplace** (or the Marketplace screen).
2. Find **Instagram** under the official store and click **Install**.
3. Review the requested permissions (`db:read`, `db:write`, `net`, `secrets`,
   `files:read`) and confirm.

Then add an account:

1. Create a Meta app at <https://developers.facebook.com/docs/instagram-platform>
   and generate a **long-lived access token** with read access to the account's
   media and messages.
2. Paste the token into the connector's setup field.

### Import an export (full history + groups)

The Graph API exposes no historical paging for DMs, so live polling is
forward-only and 1:1. To index your full history and group conversations,
request a **Download Your Information** export from Instagram (JSON format),
unzip it, and use the connector's **Import export…** action to point at the
extracted folder.

### Install from a release tarball (Tier 2)

You can also install directly from a published GitHub release: paste the
release's `.tgz` URL and its integrity hash into KIAgent's "Install from URL"
dialog.

## What it indexes

- One `instagram_chat_day` document per conversation per local-time day, merging
  both the live poll and any imported export.
- Photos / PDFs from messages (and from the export) as `file` documents. Bytes
  are cached locally (content-addressed under `<dataDir>/instagram/media/
  <sha256>`); unconvertible images keep `markdown: null` so the host auto-enrolls
  them into the deep-extraction (OCR/VLM) pass and re-reads bytes via the
  exported `makeByteSource` — no re-download.
- Metadata: thread id, participants, message timestamps, attachment ids.

Instagram is delta-only (`supportsBackfill: false`): each poll walks the recent
messages of every thread the token can see. Mojibake in exported text is
repaired on import.

## Trust model

This plugin runs in a forked Node process with the permissions you grant at
install time. It is not sandboxed at the OS level — install only connectors from
authors you trust. The source is here for audit.

## Build from source

```bash
npm install
npm run typecheck
npm test
npm run build        # → dist/index.js (self-contained CJS bundle)
npm run pack         # build + npm pack → instagram-kia-connector-<version>.tgz
```

## Releasing a new version

1. Bump `version` in **both** `package.json` and `manifest.json` (must match).
2. `npm install` (if deps changed) → `npm test` → `npm run pack`.
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

## License

MIT — see [LICENSE](./LICENSE).
