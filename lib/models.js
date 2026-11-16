/**
 * Display metadata for OpenDesign Go models.
 *
 * The subscription's model catalogue is not documented in one machine-readable
 * place: `GET /v1/models` is auth-gated, and the public price sheet carries ids
 * and prices but no names, context windows, or capabilities. This module is the
 * presentation layer for that catalogue — a curated table for the models known
 * at build time plus a deterministic fallback, so an id the provider adds
 * tomorrow still shows up with a readable name and a sane context window.
 *
 * @module dsh-opendesign-go/models
 */

/** Context window used when a model has neither a curated nor a per-model override. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Output cap used when the request names none. */
export const DEFAULT_MAX_TOKENS = 8_192;

/**
 * Curated display names for the ids the subscription lists today.
 * Keep keys exactly as the wire spells them (dots, not the site's slugs).
 */
const NAMES = {
  'claude-fable-5': 'Claude Fable 5',
  'claude-fable-5.1': 'Claude Fable 5.1',
  'claude-fable-5.2': 'Claude Fable 5.2',
  'claude-haiku-5.5': 'Claude Haiku 5.5',
  'claude-opus-4.8': 'Claude Opus 4.8',
  'claude-opus-5': 'Claude Opus 5',
  'claude-opus-5.5': 'Claude Opus 5.5',
  'claude-sonnet-5': 'Claude Sonnet 5',
  'claude-sonnet-5.5': 'Claude Sonnet 5.5',
  'deepseek-v4.1-flash': 'DeepSeek V4.1 Flash',
  'deepseek-v4.1-flash-eco': 'DeepSeek V4.1 Flash Eco',
  'deepseek-v4-flash': 'DeepSeek V4 Flash',
  'deepseek-v4-flash-vision-exp': 'DeepSeek V4 Flash Vision (exp)',
  'deepseek-v4-pro': 'DeepSeek V4 Pro',
  'gemini-3.7-flash': 'Gemini 3.7 Flash',
  'gemini-3.8-flash': 'Gemini 3.8 Flash',
  'gemini-4-argon': 'Gemini 4 Argon',
  'gemini-4-carbon': 'Gemini 4 Carbon',
  'glm-5.2': 'GLM-5.2',
  'glm-5.3-flash': 'GLM-5.3 Flash',
  'glm-5.3-flashx': 'GLM-5.3 Flash-X',
  'gpt-5.6-luna': 'GPT-5.6 Luna',
  'gpt-5.6-sol': 'GPT-5.6 Sol',
  'gpt-5.6-terra': 'GPT-5.6 Terra',
  'gpt-6-astra': 'GPT-6 Astra',
  'gpt-6-luna': 'GPT-6 Luna',
  'gpt-6-sol': 'GPT-6 Sol',
  'gpt-6.1-sol': 'GPT-6.1 Sol',
  'gpt-6.1-terra': 'GPT-6.1 Terra',
  'grok-4.5': 'Grok 4.5',
  'grok-4.6': 'Grok 4.6',
  'grok-4.7': 'Grok 4.7',
  hy4: 'HY4',
  'hy4-preview': 'HY4 Preview',
  'kimi-k2.7-code': 'Kimi K2.7 Code',
  'kimi-k3': 'Kimi K3',
  'kimi-k3.1-pro': 'Kimi K3.1 Pro',
  'mimo-v2.6-flash': 'MiMo V2.6 Flash',
  'mimo-v2.6-pro': 'MiMo V2.6 Pro',
  'minimax-m3.1-flash': 'MiniMax M3.1 Flash',
  'muse-ember-1.0': 'Muse Ember 1.0',
  'muse-spark-1.3': 'Muse Spark 1.3',
  'muse-wonder': 'Muse Wonder',
  'qwen3.7-max': 'Qwen3.7 Max',
};

/**
 * Context-window families, matched on the leading model-id fragments.
 * Values are the vendors' published windows for these generations; the
 * per-model `contextWindows` setting wins over both this table and the default.
 */
const CONTEXT_FAMILIES = [
  { match: 'gemini', contextWindow: 1_048_576 },
  { match: 'gpt-6', contextWindow: 400_000 },
  { match: 'gpt-5.6', contextWindow: 272_000 },
  { match: 'claude', contextWindow: 200_000 },
  { match: 'grok', contextWindow: 256_000 },
  { match: 'kimi', contextWindow: 262_144 },
  { match: 'qwen', contextWindow: 262_144 },
  { match: 'hy4', contextWindow: 262_144 },
  { match: 'mimo', contextWindow: 131_072 },
  { match: 'muse', contextWindow: 131_072 },
  { match: 'glm', contextWindow: 204_800 },
  { match: 'deepseek', contextWindow: 163_840 },
  { match: 'minimax', contextWindow: 196_608 },
];

/** Tokens rendered in upper case by the fallback formatter. */
const UPPER_TOKENS = new Set(['gpt', 'glm', 'hy', 'ai', 'mit', 'moe', 'lite', 'pro', 'max', 'xp', 'xl']);

/**
 * Turn a wire model id into a human-readable name.
 * @param {string} id - the provider's model id.
 * @returns {string} a display name, never empty.
 */
export function prettifyModelId(id) {
  const parts = String(id)
    .split(/[-_/]+/)
    .filter((part) => part.length > 0);
  const out = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (index > 0 && out.length > 0 && /^\d/.test(part) && /^(gpt|glm|gemini|deepseek|kimi|qwen|claude|grok)$/i.test(parts[index - 1])) {
      // `gpt-6` reads better joined than as `GPT 6`.
      out[out.length - 1] = `${out[out.length - 1]}-${part}`;
      continue;
    }
    out.push(UPPER_TOKENS.has(part.toLowerCase()) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1));
  }
  return out.join(' ') || String(id);
}

/**
 * Display name for a model id.
 * @param {string} id - the wire model id.
 * @returns {string} curated name, prettified fallback, or the id itself.
 */
export function displayName(id) {
  return NAMES[id] ?? prettifyModelId(id);
}

/**
 * Context window for a model id.
 * @param {string} id - the wire model id.
 * @param {Record<string, number>} [overrides] - per-model ids from settings.
 * @param {number} [fallback] - value used when no table or override matches.
 * @returns {number} a positive context window.
 */
export function contextWindowFor(id, overrides, fallback = DEFAULT_CONTEXT_WINDOW) {
  const override = overrides?.[id];
  if (typeof override === 'number' && override > 0) return Math.trunc(override);
  const family = CONTEXT_FAMILIES.find((entry) => id.startsWith(entry.match));
  return family?.contextWindow ?? fallback;
}

/**
 * Whether an id is one of the ids known when this plugin was written.
 * @param {string} id - the wire model id.
 * @returns {boolean} true for curated ids.
 */
export function isCurated(id) {
  return Object.hasOwn(NAMES, id);
}

/** Every curated id, in curation order. */
export const CURATED_IDS = Object.freeze(Object.keys(NAMES));
