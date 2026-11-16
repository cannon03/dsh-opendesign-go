# dsh-opendesign-go

An [OpenDesign Go](https://open-design.ai) provider for the
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): one route,
every model the subscription sells, discovered live instead of frozen into a
release.

```text
provider: opendesign-go        (OpenAI-compatible chat completions, SSE)
endpoint: https://amr-link.open-design.ai/v1
auth:     Bearer key from https://open-design.ai/cloud/api-keys
```

## Why a plugin

The harness already speaks the OpenAI wire format, but the interesting part of
this subscription is the catalogue: models appear and retire on the provider's
schedule. Hard-coding them would make the picker wrong within weeks, so the
plugin resolves the catalogue at runtime and shows whatever the subscription
lists today:

1. `GET /api/v1/public/model-prices` — open, lists every id the subscription
   sells, with per-million-token prices.
2. `GET {baseURL}/models` — auth-gated, and therefore the authoritative answer
   for the models *your plan* serves. Queried once a key resolves.
3. `extraModels` — ids you want offered even if discovery does not list them.

The union becomes the model list, cached for `catalogMinutes`. When every
network read fails, the plugin falls back to a curated catalogue of the models
known at build time, so the picker is never empty.

## Install

```bash
dsh plugin --profile web add /path/to/dsh-opendesign-go
```

The package declares `dsh.bundle.patch`, so the installer appends it to your
profile's `dsh.profile.bundles` and its `cordis.patch.yml` adds the provider
entry. Restart the app afterwards: this profile has no HMR, so a newly
installed plugin loads on the next start.

The **desktop** profile is owned by the Electron app and the CLI refuses it
(`error: profile "desktop" is managed exclusively by the Electron application`).

> **Desktop app: this plugin's card has no fields.** That app's Models page
> renders an editor only for its two built-in provider families — `layoutOf()`
> returns `"unknown"` for any other settings namespace, and that branch draws an
> explanatory paragraph and no inputs, with Save disabled:
> `dsh-client-ui-settings-models/lib/client.js` (`layoutOf`, and
> `submitDisabled: … || layout === "unknown" || …`). A third-party adapter can
> register its route and resolve models, but the GUI cannot carry its key.
>
> For the desktop app, put OpenDesign Go on the **pi-ai** route family instead
> (the same family that carried the old OpenCode Go routes) — its card renders
> the API-key field, protocol, base URL, model catalogue, and a *Fetch models*
> button that pulls the live `/v1/models` list:

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      opendesign-go:
        displayName: OpenDesign Go
        api: openai-completions
        baseURL: https://amr-link.open-design.ai/v1
        apiKeyEnv: OPENDESIGN_GO_API_KEY
        # seed `models:` from lib/models.js, or leave it out and press
        # "Fetch models" on the card to import the live /v1/models list
```

Use this plugin where there is no Models page — `headless`, `web`, `tui` — with
`OPENDESIGN_GO_API_KEY` in the environment or in the credential store.

## Add the key

**Settings → Models → OpenDesign Go → API key → Save.**

The card comes from `registerConfigurableProviders` with `settingsPath: []`, so
the plugin's whole settings section is the provider profile. Saving writes the
key into the credential service under `OPENDESIGN_GO_API_KEY` and stores the
other settings as live plugin config — no restart.

Keys are resolved in this order:

1. the credential service (`OPENDESIGN_GO_API_KEY`, wired by the card),
2. `process.env.OPENDESIGN_GO_API_KEY`,
3. anything you point `apiKeyEnv` at.

A resolved-but-unusable key fails as `INVALID_CREDENTIAL` before the request
leaves the process; a missing one fails as `MISSING_CREDENTIAL` with the
Settings path to fix it.

## Settings

| Field | Default | Meaning |
| --- | --- | --- |
| `apiKeyEnv` | `OPENDESIGN_GO_API_KEY` | Credential name holding the key |
| `baseURL` | `https://amr-link.open-design.ai/v1` | OpenAI-compatible base URL |
| `pricesURL` | `…/api/v1/public/model-prices` | Public price sheet |
| `catalogMinutes` | `10` | Catalogue freshness window (floor 30 s) |
| `contextWindow` | `200000` | Assumed window for unrecognised ids |
| `contextWindows` | `{}` | Per-model window overrides, keyed by wire id |
| `defaultMaxTokens` | `8192` | Output cap when a request sets none |
| `requestIdleTimeoutMs` | `180000` | Abort a stream that goes silent |
| `includeUsage` | `true` | Ask for streamed token usage |
| `extraModels` | `[]` | Additional ids to offer |

All fields are volatile, which is what lets the Models page rewrite them while
the harness runs. There is deliberately **no `models` field**: the Models page
validates that path against the DeepSeek catalogue shape on every save.

Wire ids use dots (`claude-opus-5.5`, `glm-5.3-flashx`), unlike the marketing
slugs on `go.open-design.ai/models/<slug>/`. The provider does not publish
context windows, so the plugin applies a per-family table (Gemini 1M, GPT-6
400k, Claude 200k, …) and lets `contextWindows` override any entry.

## Failures

| Gateway answer | Harness code |
| --- | --- |
| 401 / 403, or `invalid_api_key` | `AUTH` |
| 402, or quota/billing wording | `QUOTA` |
| 429 (honours `retry-after`) | `RATE_LIMIT` |
| 404 | `MALFORMED_RESPONSE` |
| 413, or context-window wording | `CONTEXT_WINDOW_EXCEEDED` |
| 5xx | `TRANSPORT` |
| idle stream | `TIMEOUT` |
| caller aborted | `ABORTED` |
| completed, no content | `EMPTY_RESPONSE` |

Provider message text is preserved (400-char snippet) so the reason shows up in
the transcript instead of a bare status code. Some OpenAI-compatible gateways
reject `stream_options`; on that specific 400 the plugin retries once without
it rather than failing a call the provider would otherwise serve.

## Development

```bash
npm test              # 18 checks: schema, wire, SSE, adapter, live catalogue
SKIP_NETWORK=1 npm test   # offline
```

The tests run the plugin against the real harness packages and a throwaway
local server that speaks the SSE dialect, so no key is needed. The plugin
imports only `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-credentials`, and
`@deepseek-ai/schemastery`; they are `peerDependencies` on purpose (the harness
is a single instance and intercepts those bare imports itself), which means a
fresh checkout needs the harness modules linked into `node_modules/` to run
the tests.

## Layout

```text
lib/index.js    plugin entry: Config schema, credential resolution, registration
lib/adapter.js  LlmAdapter subclass: stream, model resolution, failure mapping
lib/catalog.js  price sheet + /models discovery, cache, curated fallback
lib/wire.js     harness ⇄ OpenAI request/stream translation
lib/sse.js      dependency-free SSE reader
lib/models.js   display names, context-window families, curated ids
```
