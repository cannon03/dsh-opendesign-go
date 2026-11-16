/**
 * DeepSeek Harness plugin: OpenDesign Go as an LLM provider.
 *
 * The plugin registers one route (`opendesign-go`) backed by the public
 * OpenDesign Go API. Its catalogue is discovered at runtime from the public
 * price sheet plus the authenticated `/models` endpoint, so new models appear
 * in the picker without a plugin release.
 *
 * The API key is entered in Settings → Models → OpenDesign Go; the key is
 * stored in the credential service under `OPENDESIGN_GO_API_KEY`, or read
 * from that environment variable, or written into {@link Config.apiKeyEnv}.
 *
 * @module dsh-opendesign-go
 */

import { credentialRef } from '@deepseek-ai/dsh-credentials';
import z from '@deepseek-ai/schemastery';
import { OpenDesignGoAdapter, PACKAGE_NAME, PROVIDER_ID } from './adapter.js';
import { DEFAULT_PRICES_URL, OpenDesignCatalog } from './catalog.js';
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from './models.js';

/** Plugin name, as it appears in `cordis.yml` and the plugin manager. */
export const name = 'dsh-opendesign-go';

/** Services this plugin needs before it can start. */
export const inject = ['llm'];

/** Credential name the Settings → Models card writes to by default. */
export const DEFAULT_API_KEY_ENV = 'OPENDESIGN_GO_API_KEY';

/** Base URL of the OpenAI-compatible endpoint. */
export const DEFAULT_BASE_URL = 'https://amr-link.open-design.ai/v1';

/**
 * Plugin configuration. Every field is volatile so the Models page can write
 * it while the harness runs. There is deliberately no `models` field: the
 * Models page validates that path against the DeepSeek catalogue shape.
 */
export const Config = z.object({
  apiKeyEnv: z
    .string()
    .default(DEFAULT_API_KEY_ENV)
    .role('credential-ref')
    .description('Credential name that holds the OpenDesign Go API key')
    .volatile(),
  baseURL: z
    .string()
    .default(DEFAULT_BASE_URL)
    .description('OpenAI-compatible base URL')
    .volatile(),
  pricesURL: z
    .string()
    .default(DEFAULT_PRICES_URL)
    .description('Public price sheet used to discover models without a key')
    .volatile(),
  catalogMinutes: z
    .natural()
    .default(10)
    .description('Minutes a discovered catalogue stays fresh')
    .volatile(),
  contextWindow: z
    .natural()
    .default(DEFAULT_CONTEXT_WINDOW)
    .description('Context window assumed when a model is not recognised')
    .volatile(),
  contextWindows: z
    .dict(z.natural())
    .default({})
    .description('Per-model context-window overrides, keyed by model id')
    .volatile(),
  defaultMaxTokens: z
    .natural()
    .default(DEFAULT_MAX_TOKENS)
    .description('Output-token cap when a request does not set one')
    .volatile(),
  requestIdleTimeoutMs: z
    .natural()
    .default(180_000)
    .description('Abort a stream that sends nothing for this long')
    .volatile(),
  includeUsage: z
    .boolean()
    .default(true)
    .description('Ask the provider to stream token usage')
    .volatile(),
  extraModels: z
    .array(z.string())
    .default([])
    .description('Model ids to offer even when discovery does not list them')
    .volatile(),
});

/**
 * Read a config field that may be a settings ref or a plain value.
 * @param {object} config - the plugin config.
 * @param {string} key - the field name.
 * @param {unknown} fallback - value used when the field is unset.
 * @returns {unknown} the current value.
 */
function readField(config, key, fallback) {
  const field = config?.[key];
  const value = field !== undefined && typeof field.get === 'function' ? field.get() : field;
  return value === undefined || value === null ? fallback : value;
}

/**
 * Snapshot the settings a single call should use.
 * @param {object} config - the plugin config.
 * @returns {object} resolved settings.
 */
function snapshot(config) {
  return {
    apiKeyEnv: String(readField(config, 'apiKeyEnv', DEFAULT_API_KEY_ENV)).trim() || DEFAULT_API_KEY_ENV,
    baseURL: String(readField(config, 'baseURL', DEFAULT_BASE_URL)).replace(/\/+$/, '') || DEFAULT_BASE_URL,
    pricesURL: String(readField(config, 'pricesURL', DEFAULT_PRICES_URL)) || DEFAULT_PRICES_URL,
    catalogMinutes: Number(readField(config, 'catalogMinutes', 10)) || 10,
    contextWindow: Number(readField(config, 'contextWindow', DEFAULT_CONTEXT_WINDOW)) || DEFAULT_CONTEXT_WINDOW,
    contextWindows: readField(config, 'contextWindows', {}) ?? {},
    defaultMaxTokens: Number(readField(config, 'defaultMaxTokens', DEFAULT_MAX_TOKENS)) || DEFAULT_MAX_TOKENS,
    requestIdleTimeoutMs: Number(readField(config, 'requestIdleTimeoutMs', 180_000)) || 180_000,
    includeUsage: readField(config, 'includeUsage', true) !== false,
    extraModels: Array.isArray(readField(config, 'extraModels', [])) ? readField(config, 'extraModels', []) : [],
  };
}

/**
 * Resolve the API key: the credential service first, then the environment.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {string} ref - the credential name.
 * @returns {Promise<string | undefined>} the key, when one is configured.
 */
async function resolveApiKey(ctx, ref) {
  const credentials = ctx.get('credentials');
  if (credentials !== undefined && typeof credentials.resolve === 'function') {
    try {
      const hit = await credentials.resolve(credentialRef(ref));
      const value = typeof hit === 'string' ? hit : hit?.value;
      if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    } catch {
      // An unparsable ref name is not a reason to stop: fall back to the env.
    }
  }
  const fromEnv = process.env[ref];
  return typeof fromEnv === 'string' && fromEnv.trim().length > 0 ? fromEnv.trim() : undefined;
}

/**
 * Register the provider.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {object} config - the resolved plugin config.
 */
export function apply(ctx, config) {
  const log = (level, message) => {
    const logger = ctx.logger;
    const emit = logger?.[level] ?? logger?.info;
    if (typeof emit === 'function') emit.call(logger, message);
    else if (level === 'warn' || level === 'error') console.warn(`[${PACKAGE_NAME}] ${String(message)}`);
  };
  const settings = () => snapshot(config);
  const current = () => settings();
  const hit = () => resolveApiKey(ctx, current().apiKeyEnv);

  const catalog = new OpenDesignCatalog({
    setting: (key) => current()[key],
    apiKey: hit,
    log,
  });
  const adapter = new OpenDesignGoAdapter({
    models: async () => {
      const discovered = await catalog.get();
      return discovered.models;
    },
    apiKey: hit,
    settings: current,
    log,
  });

  const settingsNs = ctx.fiber?.entry?.options?.id ?? name;
  ctx.llm.registerAdapter([PROVIDER_ID], adapter);
  ctx.llm.registerConfigurableProviders([
    {
      provider: PROVIDER_ID,
      displayName: 'OpenDesign Go',
      settingsNs,
      settingsPath: [],
    },
  ]);
  log('debug', `${PACKAGE_NAME}: registered route "${PROVIDER_ID}" (settings section "${settingsNs}")`);
}
