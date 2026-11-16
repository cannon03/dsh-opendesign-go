/**
 * Live model catalogue for OpenDesign Go.
 *
 * Two sources are merged:
 *
 *  1. `GET /api/v1/public/model-prices` on the OpenDesign console host — open to
 *     unauthenticated callers, lists every model id the subscription sells, and
 *     carries per-million-token prices. This is what makes the picker complete
 *     before the user has entered a key.
 *  2. `GET {baseURL}/models` — auth-gated, and therefore the authoritative answer
 *     for the models the caller's plan actually serves. Queried only once a key
 *     resolves.
 *
 * Prices are advisory; membership is the union of what either source returns, so
 * a model the plan cannot serve still appears (and fails with the provider's own
 * message when used) instead of silently vanishing from a catalogue that is meant
 * to show everything available.
 *
 * @module dsh-opendesign-go/catalog
 */

import {
  CURATED_IDS,
  DEFAULT_CONTEXT_WINDOW,
  SERVED_IDS,
  capabilitiesFor,
  contextWindowFor,
  displayName,
  inputModalitiesFor,
  reasoningEffortsFor,
} from './models.js';

/** Default public price sheet used when the setting is left at its default. */
export const DEFAULT_PRICES_URL = 'https://amr-api.open-design.ai/api/v1/public/model-prices';

/** How long a successful read is served before another read is attempted. */
export const DEFAULT_TTL_MS = 10 * 60 * 1000;

const FETCH_TIMEOUT_MS = 8_000;

/** Prefixes some OpenAI-shaped clients put in front of the bare model id. */
const ID_PREFIXES = ['corouter/', 'open-design/', 'opendesign/', 'open_design/'];

function stripPrefix(id) {
  for (const prefix of ID_PREFIXES) {
    if (id.startsWith(prefix)) return id.slice(prefix.length);
  }
  return id;
}

function asPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Read a JSON document with a hard timeout.
 * @param {string} url - absolute URL.
 * @param {Record<string, string>} [headers] - request headers.
 * @returns {Promise<unknown>} the parsed document.
 */
async function fetchJson(url, headers) {
  const response = await fetch(url, {
    method: 'GET',
    headers: { accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${url} answered HTTP ${String(response.status)}: ${text.slice(0, 240)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${url} answered with a non-JSON body: ${text.slice(0, 240)}`, { cause: error });
  }
}

/**
 * Parse the public price sheet into `id -> pricing`.
 * @param {unknown} document - the decoded response.
 * @returns {Map<string, object>} prices keyed by model id, in document order.
 */
export function parsePriceSheet(document) {
  const rows = Array.isArray(document) ? document : Array.isArray(document?.data) ? document.data : [];
  const prices = new Map();
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const raw = typeof row.model === 'string' ? row.model : typeof row.id === 'string' ? row.id : undefined;
    if (raw === undefined) continue;
    const id = stripPrefix(raw.trim());
    if (id.length === 0) continue;
    const pricing = row.pricing ?? row.price ?? {};
    prices.set(id, {
      input: asPositiveNumber(pricing.input),
      output: asPositiveNumber(pricing.output),
      cacheRead: asPositiveNumber(pricing.cacheRead ?? pricing.cache_read),
      cacheWrite: asPositiveNumber(pricing.cacheWrite ?? pricing.cache_write),
      currency: typeof pricing.currency === 'string' ? pricing.currency : 'USD',
      unit: typeof pricing.unit === 'string' ? pricing.unit : '1m_tokens',
    });
  }
  return prices;
}

/**
 * Parse an OpenAI-shaped model list, tolerating both the standard `data` array and
 * the console's enriched `models` map.
 * @param {unknown} document - the decoded response.
 * @returns {string[]} model ids in document order.
 */
export function parseModelList(document) {
  const ids = [];
  const push = (value) => {
    if (typeof value !== 'string') return;
    const id = stripPrefix(value.trim());
    if (id.length > 0 && !ids.includes(id)) ids.push(id);
  };
  const fromEntry = (entry) => {
    if (typeof entry === 'string') return push(entry);
    if (typeof entry !== 'object' || entry === null) return;
    if (typeof entry.id === 'string') return push(entry.id);
    if (typeof entry.model === 'string') return push(entry.model);
    if (typeof entry.name === 'string') return push(entry.name);
  };
  const source = document?.models ?? document?.data ?? document;
  if (Array.isArray(source)) {
    for (const entry of source) fromEntry(entry);
  } else if (typeof source === 'object' && source !== null) {
    // The enriched map form keys entries by model id.
    for (const key of Object.keys(source)) push(key);
  }
  return ids;
}

/**
 * Format a price sheet row for the model picker's description line.
 * @param {{input?: number, output?: number, currency?: string}} pricing - the row.
 * @returns {string | undefined} a compact price summary.
 */
function describePricing(pricing) {
  if (pricing === undefined) return undefined;
  const parts = [];
  if (pricing.input !== undefined) parts.push(`$${formatPrice(pricing.input)}/M in`);
  if (pricing.output !== undefined) parts.push(`$${formatPrice(pricing.output)}/M out`);
  if (parts.length === 0) return undefined;
  return parts.join(' · ');
}

function formatPrice(value) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

/**
 * A cached, resilient view of the OpenDesign Go catalogue.
 */
export class OpenDesignCatalog {
  /**
   * @param {object} options - catalogue configuration.
   * @param {(name: string) => string} options.setting - live setting reader.
   * @param {() => Promise<string | undefined>} options.apiKey - resolves the key, if any.
   * @param {(level: string, message: unknown) => void} [options.log] - logger.
   */
  constructor({ setting, apiKey, log }) {
    this.setting = setting;
    this.apiKey = apiKey;
    this.log = log ?? (() => undefined);
    this.cache = undefined;
    this.inflight = undefined;
    this.lastKeyState = false;
  }

  /** Drop the cached snapshot. */
  invalidate() {
    this.cache = undefined;
  }

  /**
   * Read the catalogue, refreshing when stale.
   * @param {{force?: boolean}} [options] - `force` bypasses the TTL.
   * @returns {Promise<{models: object[], source: string, fetchedAt: number, stale: boolean}>} the snapshot.
   */
  async get(options = {}) {
    const ttl = Math.max(30_000, this.setting('catalogMinutes') * 60_000);
    const key = await this.safeApiKey();
    const hasKey = key !== undefined;
    if (!options.force && this.cache !== undefined && this.cache.keyState === hasKey && Date.now() - this.cache.fetchedAt < ttl) {
      return this.cache;
    }
    if (this.inflight !== undefined) return this.inflight;
    this.inflight = this.refresh(key)
      .catch((error) => {
        this.log('warn', `dsh-opendesign-go: model catalogue refresh failed: ${String(error?.message ?? error)}`);
        if (this.cache !== undefined) return { ...this.cache, stale: true };
        return this.fallback();
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }

  async safeApiKey() {
    try {
      return await this.apiKey();
    } catch {
      return undefined;
    }
  }

  /**
   * Fetch both sources and merge them into one snapshot.
   * @param {string | undefined} key - the resolved API key, when one exists.
   * @returns {Promise<object>} the snapshot.
   */
  async refresh(key) {
    const failures = [];
    let prices;
    try {
      prices = parsePriceSheet(await fetchJson(this.setting('pricesURL')));
    } catch (error) {
      failures.push(error);
    }
    let served;
    if (key !== undefined) {
      try {
        served = parseModelList(await fetchJson(`${this.setting('baseURL')}/models`, { authorization: `Bearer ${key}` }));
      } catch (error) {
        failures.push(error);
      }
    }
    // Neither source answered: serve the curated catalogue rather than a
    // snapshot built from the capability table alone, which would look like a
    // successful read of a fourteen-model plan.
    if (prices === undefined && served === undefined) {
      for (const failure of failures) this.log('warn', `dsh-opendesign-go: ${String(failure?.message ?? failure)}`);
      return this.fallback();
    }
    const ids = [];
    for (const id of prices?.keys() ?? []) ids.push(id);
    for (const id of served ?? []) if (!ids.includes(id)) ids.push(id);
    // The capability table names models the subscription demonstrably serves;
    // keep them listed even when a source omits them.
    for (const id of SERVED_IDS) if (!ids.includes(id)) ids.push(id);
    for (const id of this.setting('extraModels') ?? []) if (typeof id === 'string' && id.length > 0 && !ids.includes(id)) ids.push(id);
    const snapshot = {
      models: ids.map((id) => this.entry(id, prices?.get(id))),
      source: prices !== undefined && served !== undefined ? 'prices+models' : prices !== undefined ? 'prices' : 'models',
      fetchedAt: Date.now(),
      keyState: key !== undefined,
      stale: false,
    };
    this.cache = snapshot;
    return snapshot;
  }

  /**
   * Build one catalogue entry.
   * @param {string} id - wire model id.
   * @param {object} [pricing] - price sheet row, when one exists.
   * @returns {object} the catalogue entry.
   */
  entry(id, pricing) {
    const overrides = this.setting('contextWindows');
    const prefix = describePricing(pricing);
    const capabilities = capabilitiesFor(id);
    return {
      id,
      name: displayName(id),
      contextWindow: capabilities?.contextWindow ?? contextWindowFor(id, overrides, this.setting('contextWindow') ?? DEFAULT_CONTEXT_WINDOW),
      ...(capabilities === undefined ? {} : { maxTokens: capabilities.maxTokens }),
      inputModalities: inputModalitiesFor(id),
      reasoningEfforts: reasoningEffortsFor(id),
      ...(prefix === undefined ? {} : { description: `OpenDesign Go · ${prefix}`, pricing }),
    };
  }

  /** The curated catalogue, used when every network read fails. */
  fallback() {
    const extra = (this.setting('extraModels') ?? []).filter((id) => typeof id === 'string' && id.length > 0);
    const ids = [...CURATED_IDS];
    for (const id of SERVED_IDS) if (!ids.includes(id)) ids.push(id);
    for (const id of extra) if (!ids.includes(id)) ids.push(id);
    return {
      models: ids.map((id) => this.entry(id)),
      source: 'curated',
      fetchedAt: Date.now(),
      keyState: false,
      stale: true,
    };
  }
}
