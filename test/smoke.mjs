/**
 * Smoke tests for dsh-opendesign-go.
 *
 * These run against the real harness packages (the `@deepseek-ai/*` modules are
 * symlinked into `node_modules/`) and a throwaway local HTTP server that speaks
 * the OpenAI-compatible SSE dialect, so no network or API key is required
 * except for the optional catalogue test.
 *
 * Usage: node test/smoke.mjs   (SKIP_NETWORK=1 to skip the live price sheet)
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { OpenDesignCatalog } from '../lib/catalog.js';
import { Config, apply, name as PLUGIN_NAME } from '../lib/index.js';
import { WireTranslator, mapFinishReason, serializeRequest } from '../lib/wire.js';
import { OpenDesignGoAdapter } from '../lib/adapter.js';

const results = [];
let failures = 0;

/** Run one named check, recording pass/fail instead of aborting the run. */
async function check(label, fn) {
  try {
    await fn();
    results.push(`  ok   ${label}`);
  } catch (error) {
    failures += 1;
    results.push(`  FAIL ${label}\n         ${String(error?.stack ?? error).split('\n').slice(0, 4).join('\n         ')}`);
  }
}

/** Collect every chunk an async iterable yields. */
async function drain(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

/** Reject with the thrown error, for assertions on thrown failures. */
async function thrown(fn) {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the operation to throw');
}

const SSE_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' };

function sse(res, frames) {
  res.writeHead(200, SSE_HEADERS);
  for (const frame of frames) res.write(`data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`);
  res.end('data: [DONE]\n\n');
}

const PRICE_SHEET = {
  data: [
    { model: 'gpt-6-astra', pricing: { unit: '1m_tokens', currency: 'USD', input: 3, output: 15, cacheRead: 0.3 } },
    { model: 'claude-opus-5.5', pricing: { unit: '1m_tokens', currency: 'USD', input: 5, output: 25 } },
    { model: 'deepseek-v4.1-flash', pricing: { unit: '1m_tokens', currency: 'USD', input: 0.2, output: 0.8 } },
  ],
};

/**
 * Start a scripted server: `POST /v1/chat/completions` runs the next handler in
 * `handlers`, `GET /prices` serves the sheet.
 */
async function scriptedServer(handlers) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (req.url === '/prices') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(PRICE_SHEET));
        return;
      }
      seen.push({ url: req.url, headers: req.headers, body: body.length === 0 ? undefined : JSON.parse(body) });
      const handler = handlers[Math.min(seen.length - 1, handlers.length - 1)];
      handler(req, res, seen[seen.length - 1]);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseURL: `http://127.0.0.1:${String(port)}/v1`,
    pricesURL: `http://127.0.0.1:${String(port)}/prices`,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** A minimal cordis-like context that records llm registrations. */
function fakeContext({ credentials, settingsId = 'dsh-opendesign-go' } = {}) {
  const calls = { adapter: undefined, directory: undefined, providers: undefined };
  const ctx = {
    fiber: { entry: { options: { id: settingsId } } },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    get: (service) => (service === 'credentials' ? credentials : undefined),
    llm: {
      registerAdapter(providers, adapter) {
        calls.providers = providers;
        calls.adapter = adapter;
        return () => {};
      },
      registerConfigurableProviders(entries) {
        calls.directory = entries;
        return () => {};
      },
    },
  };
  return { ctx, calls };
}

/** Settings snapshot the adapter expects. */
function settingsFor(baseURL, pricesURL, overrides = {}) {
  return {
    apiKeyEnv: 'OPENDESIGN_GO_API_KEY',
    baseURL,
    pricesURL,
    catalogMinutes: 1,
    contextWindow: 200_000,
    contextWindows: {},
    defaultMaxTokens: 8_192,
    requestIdleTimeoutMs: 5_000,
    includeUsage: true,
    extraModels: [],
    ...overrides,
  };
}

function textFrame(text) {
  return { id: 'chunk', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] };
}

function stopFrame(usage) {
  return {
    id: 'chunk',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage,
  };
}

// ---------------------------------------------------------------------------
// Schema and serialization
// ---------------------------------------------------------------------------

await check('Config exposes volatile defaults for the Models page', () => {
  assert.equal(PLUGIN_NAME, 'dsh-opendesign-go');
  const parsed = Config({});
  // Volatile fields materialise as `{ get }` refs so the settings service can
  // rewrite them at runtime without restarting the plugin.
  const value = (key) => (typeof parsed[key]?.get === 'function' ? parsed[key].get() : parsed[key]);
  assert.equal(value('apiKeyEnv'), 'OPENDESIGN_GO_API_KEY');
  assert.equal(value('baseURL'), 'https://amr-link.open-design.ai/v1');
  assert.equal(value('defaultMaxTokens'), 8_192);
  assert.equal(value('includeUsage'), true);
  assert.deepEqual(value('extraModels'), []);
  assert.equal(parsed.models, undefined, 'Config must not define a models field');
  for (const key of Object.keys(Config.dict)) {
    assert.equal(Config.dict[key].meta.volatile, true, `${key} must be .volatile() so the Models page can write it`);
  }
});

await check('serializeRequest produces an OpenAI streaming body', () => {
  const body = serializeRequest(
    {
      model: 'gpt-6-astra',
      system: 'be brief',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{"p":"a"}' }] },
        { role: 'tool', source: { kind: 'tool' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'file body' }] }] },
      ],
      tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
      temperature: 0.2,
      maxTokens: 64,
    },
    { defaultMaxTokens: 8_192, includeUsage: true },
  );
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.max_tokens, 64);
  assert.equal(body.temperature, 0.2);
  assert.deepEqual(body.messages[0], { role: 'system', content: 'be brief' });
  assert.deepEqual(body.messages[2], {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"p":"a"}' } }],
  });
  assert.deepEqual(body.messages[3], { role: 'tool', content: 'file body', tool_call_id: 'c1' });
  assert.deepEqual(body.tools, [{ type: 'function', function: { name: 'read', description: 'read a file', parameters: { type: 'object' } } }]);
});

await check('includeUsage=false drops stream_options', () => {
  const body = serializeRequest({ model: 'm', messages: [] }, { defaultMaxTokens: 1, includeUsage: false });
  assert.equal(body.stream_options, undefined);
});

await check('mapFinishReason covers the harness vocabulary', () => {
  assert.deepEqual(mapFinishReason('stop'), { kind: 'stop' });
  assert.deepEqual(mapFinishReason('tool_calls'), { kind: 'tool-calls' });
  assert.deepEqual(mapFinishReason('length'), { kind: 'max-tokens' });
  assert.equal(mapFinishReason('nonsense'), undefined);
});

// ---------------------------------------------------------------------------
// Translator
// ---------------------------------------------------------------------------

await check('WireTranslator streams text, closes blocks, reports usage', () => {
  const translator = new WireTranslator();
  const early = translator.push(textFrame('Hel')).concat(translator.push(textFrame('lo')));
  assert.deepEqual(early, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'Hel' },
    { type: 'text-delta', index: 0, text: 'lo' },
  ]);
  translator.push(stopFrame({ prompt_tokens: 12, completion_tokens: 2, total_tokens: 14, prompt_tokens_details: { cached_tokens: 4 } }));
  const { chunks } = translator.finish();
  assert.deepEqual(chunks[0], { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } });
  assert.deepEqual(chunks[1], { type: 'usage', usage: { inputTokens: 8, outputTokens: 2, totalTokens: 14, cacheReadTokens: 4 } });
  assert.deepEqual(chunks[2], { type: 'finish', reason: { kind: 'stop' } });
});

await check('WireTranslator assembles tool calls and infers tool-calls', () => {
  const translator = new WireTranslator();
  translator.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'shell', arguments: '{"cmd":' } }] } }] });
  translator.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] } }] });
  const { chunks } = translator.finish();
  assert.deepEqual(chunks.at(-2), { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_a', name: 'shell', arguments: '{"cmd":"ls"}' } });
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } });
});

await check('WireTranslator flags an empty completion', () => {
  const { chunks } = new WireTranslator().finish();
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].reason.kind, 'error');
  assert.equal(chunks[0].reason.failure.code, 'EMPTY_RESPONSE');
});

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

await check('OpenDesignCatalog discovers models from the price sheet', async () => {
  const server = await scriptedServer([(req, res) => sse(res, [])]);
  try {
    const catalog = new OpenDesignCatalog({
      setting: (key) => settingsFor(server.baseURL, server.pricesURL)[key],
      apiKey: async () => undefined,
      log: () => {},
    });
    const sheet = await catalog.get();
    assert.equal(sheet.models.length, 16, 'the three priced models plus the thirteen others the plan serves');
    const astra = sheet.models.find((model) => model.id === 'gpt-6-astra');
    assert.ok(astra, 'gpt-6-astra must be present');
    assert.equal(astra.name, 'GPT-6 Astra');
    assert.match(astra.description, /\$3\/M in · \$15\/M out/);
    assert.equal(astra.contextWindow, 400_000);
    assert.equal(sheet.models.find((model) => model.id === 'deepseek-v4.1-flash').name, 'DeepSeek V4.1 Flash');
  } finally {
    await server.close();
  }
});

await check('OpenDesignCatalog falls back to curated ids when unreachable', async () => {
  const catalog = new OpenDesignCatalog({
    setting: (key) => settingsFor('http://127.0.0.1:1/v1', 'http://127.0.0.1:1/prices')[key],
    apiKey: async () => undefined,
    log: () => {},
  });
  const sheet = await catalog.get();
  assert.ok(sheet.models.length >= 44, 'the curated catalogue must cover the subscription');
  assert.ok(sheet.models.some((model) => model.id === 'kimi-k3.1-pro'));
});

await check('catalogue rows carry the entitled capabilities', async () => {
  const server = await scriptedServer([(req, res) => sse(res, [])]);
  try {
    const catalog = new OpenDesignCatalog({
      setting: (key) => settingsFor(server.baseURL, server.pricesURL)[key],
      apiKey: async () => undefined,
      log: () => {},
    });
    const sheet = await catalog.get();
    const eco = sheet.models.find((model) => model.id === 'deepseek-v4.1-flash-eco');
    assert.ok(eco, 'an entitled model must be present even when the price sheet omits it');
    assert.equal(eco.contextWindow, 328_000);
    assert.equal(eco.maxTokens, 128_000);
    assert.deepEqual(eco.inputModalities, ['text']);
    assert.deepEqual(eco.reasoningEfforts, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    const haiku = sheet.models.find((model) => model.id === 'claude-haiku-5.5');
    assert.deepEqual(haiku.inputModalities, ['text', 'image']);
    assert.deepEqual(sheet.models.find((model) => model.id === 'glm-5.3-flashx').reasoningEfforts, ['minimal', 'low', 'high', 'xhigh', 'max']);
    assert.deepEqual(sheet.models.find((model) => model.id === 'kimi-k2.7-code').reasoningEfforts, ['minimal', 'low', 'medium', 'high', 'xhigh']);
  } finally {
    await server.close();
  }
});

await check('resolveModel advertises the verified reasoning levels', async () => {
  const server = await scriptedServer([(req, res) => sse(res, [])]);
  const adapter = new OpenDesignGoAdapter({
    setting: (key) => settingsFor(server.baseURL, server.pricesURL)[key],
    models: () => new OpenDesignCatalog({
      setting: (key) => settingsFor(server.baseURL, server.pricesURL)[key],
      apiKey: async () => undefined,
      log: () => {},
    }).get().then((sheet) => sheet.models),
    apiKey: async () => 'sk-test',
    settings: () => settingsFor(server.baseURL, server.pricesURL),
    log: () => {},
  });
  const info = await adapter.resolveModel('opendesign-go', 'deepseek-v4.1-flash');
  assert.deepEqual(info.reasoning.efforts.map((effort) => effort.id), ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(info.reasoning.efforts[0].name, 'Minimal');
  assert.deepEqual(info.inputModalities, ['text', 'image']);
  assert.equal(info.context.contextWindow, 328_000);
  assert.equal(info.defaultMaxTokens, 128_000);
  const filtered = await adapter.resolveModel('opendesign-go', 'glm-5.3-flashx');
  assert.deepEqual(filtered.reasoning.efforts.map((effort) => effort.id), ['minimal', 'low', 'high', 'xhigh', 'max']);
  const unknown = await adapter.resolveModel('opendesign-go', 'not-in-the-catalogue');
  assert.equal(unknown.reasoning, undefined, 'an unknown model must not claim reasoning');
  await server.close();
});

await check('OpenDesignCatalog merges extraModels', async () => {
  const server = await scriptedServer([(req, res) => sse(res, [])]);
  try {
    const settings = settingsFor(server.baseURL, server.pricesURL, { extraModels: ['muse-ember-1.0'] });
    const catalog = new OpenDesignCatalog({ setting: (key) => settings[key], apiKey: async () => undefined, log: () => {} });
    const sheet = await catalog.get();
    assert.ok(sheet.models.some((model) => model.id === 'muse-ember-1.0'));
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// Adapter over a real socket
// ---------------------------------------------------------------------------

await check('adapter streams a completion end to end', async () => {
  const server = await scriptedServer([
    (req, res) => sse(res, [textFrame('Hello'), textFrame(' there'), stopFrame({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 })]),
  ]);
  try {
    const { ctx, calls } = fakeContext({ credentials: { resolve: async () => ({ value: 'sk-live-key' }) } });
    apply(ctx, Config({ baseURL: server.baseURL, pricesURL: server.pricesURL }));
    assert.deepEqual(calls.providers, ['opendesign-go']);
    assert.equal(calls.adapter.providerInfo('opendesign-go').name, 'OpenDesign Go');

    const adapter = calls.adapter;
    const models = await adapter.listModels('opendesign-go');
    assert.equal(models.length, 16);
    assert.deepEqual(models[0].inputModalities, ['text']);

    const chunks = await drain(
      adapter.stream({
        provider: 'opendesign-go',
        model: 'gpt-6-astra',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      }),
    );
    const kinds = chunks.map((chunk) => chunk.type);
    assert.deepEqual(kinds, ['block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish']);
    assert.equal(chunks[1].text + chunks[2].text, 'Hello there');
    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } });

    const request = server.seen.at(-1);
    assert.equal(request.headers.authorization, 'Bearer sk-live-key');
    assert.match(String(request.headers['user-agent']), /deepseek-harness/i);
    assert.equal(request.body.model, 'gpt-6-astra');
    assert.equal(request.body.stream, true);
    assert.deepEqual(request.body.stream_options, { include_usage: true });
  } finally {
    await server.close();
  }
});

await check('adapter reports a rejected key as AUTH', async () => {
  const server = await scriptedServer([
    (req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'missing_api_key', message: 'missing or invalid authorization header' } }));
    },
  ]);
  try {
    const { ctx, calls } = fakeContext({ credentials: { resolve: async () => ({ value: 'sk-wrong' }) } });
    apply(ctx, Config({ baseURL: server.baseURL, pricesURL: server.pricesURL }));
    const adapter = calls.adapter;
    const error = await thrown(() =>
      drain(adapter.stream({ provider: 'opendesign-go', model: 'gpt-6-astra', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })),
    );
    assert.equal(error.code ?? error.failure?.code, 'AUTH');
    assert.match(String(error.message), /HTTP 401/);
  } finally {
    await server.close();
  }
});

await check('adapter asks for a key when none is configured', async () => {
  const previous = process.env.OPENDESIGN_GO_API_KEY;
  delete process.env.OPENDESIGN_GO_API_KEY;
  try {
    const { ctx, calls } = fakeContext({ credentials: { resolve: async () => undefined } });
    apply(ctx, Config({ baseURL: 'http://127.0.0.1:1/v1', pricesURL: 'http://127.0.0.1:1/prices' }));
    const error = await thrown(() =>
      drain(calls.adapter.stream({ provider: 'opendesign-go', model: 'gpt-6-astra', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })),
    );
    assert.equal(error.code ?? error.failure?.code, 'MISSING_CREDENTIAL');
    assert.match(String(error.message), /Settings → Models/);
  } finally {
    if (previous !== undefined) process.env.OPENDESIGN_GO_API_KEY = previous;
  }
});

await check('adapter retries once when the gateway rejects stream_options', async () => {
  const server = await scriptedServer([
    (req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unsupported parameter: stream_options' } }));
    },
    (req, res) => sse(res, [textFrame('ok')]),
  ]);
  try {
    const { ctx, calls } = fakeContext({ credentials: { resolve: async () => ({ value: 'sk-key' }) } });
    apply(ctx, Config({ baseURL: server.baseURL, pricesURL: server.pricesURL }));
    const adapter = calls.adapter;
    const chunks = await drain(
      adapter.stream({ provider: 'opendesign-go', model: 'gpt-6-astra', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }),
    );
    assert.equal(chunks.find((chunk) => chunk.type === 'text-delta').text, 'ok');
    assert.equal(server.seen.length, 2);
    assert.equal(server.seen[1].body.stream_options, undefined);
  } finally {
    await server.close();
  }
});

await check('adapter surfaces an idle stream as TIMEOUT', async () => {
  const server = await scriptedServer([
    (req, res) => {
      res.writeHead(200, SSE_HEADERS);
      res.flushHeaders();
      // Never write a frame: the adapter's idle watchdog must fire.
    },
  ]);
  try {
    const { ctx, calls } = fakeContext({ credentials: { resolve: async () => ({ value: 'sk-key' }) } });
    apply(ctx, Config({ baseURL: server.baseURL, pricesURL: server.pricesURL, requestIdleTimeoutMs: 120 }));
    const adapter = calls.adapter;
    const error = await thrown(() =>
      drain(adapter.stream({ provider: 'opendesign-go', model: 'gpt-6-astra', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })),
    );
    assert.equal(error.code ?? error.failure?.code, 'TIMEOUT');
  } finally {
    await server.close();
  }
});

await check('adapter never leaks a rate-limit retry hint of zero', async () => {
  const server = await scriptedServer([
    (req, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' });
      res.end(JSON.stringify({ error: { message: 'slow down' } }));
    },
  ]);
  try {
    const { ctx, calls } = fakeContext({ credentials: { resolve: async () => ({ value: 'sk-key' }) } });
    apply(ctx, Config({ baseURL: server.baseURL, pricesURL: server.pricesURL }));
    const adapter = calls.adapter;
    const error = await thrown(() =>
      drain(adapter.stream({ provider: 'opendesign-go', model: 'gpt-6-astra', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })),
    );
    assert.equal(error.code ?? error.failure?.code, 'RATE_LIMIT');
    assert.equal(error.failure?.providerRetryAfterMs ?? error.providerRetryAfterMs, 2_000);
  } finally {
    await server.close();
  }
});

await check('apply registers the route and a whole-section provider card', async () => {
  const { ctx, calls } = fakeContext({ credentials: { resolve: async () => undefined }, settingsId: 'dsh-opendesign-go' });
  apply(ctx, Config({}));
  assert.deepEqual(calls.providers, ['opendesign-go']);
  assert.equal(calls.directory.length, 1);
  const entry = calls.directory[0];
  assert.equal(entry.provider, 'opendesign-go');
  assert.equal(entry.displayName, 'OpenDesign Go');
  assert.equal(entry.settingsNs, 'dsh-opendesign-go');
  assert.deepEqual(entry.settingsPath, []);
});

// ---------------------------------------------------------------------------
// Live discovery (optional)
// ---------------------------------------------------------------------------

if (process.env.SKIP_NETWORK !== '1') {
  await check('live price sheet lists the current subscription catalogue', async () => {
    const catalog = new OpenDesignCatalog({
      setting: (key) => settingsFor('https://amr-link.open-design.ai/v1', 'https://amr-api.open-design.ai/api/v1/public/model-prices')[key],
      apiKey: async () => undefined,
      log: () => {},
    });
    const sheet = await catalog.get();
    assert.ok(sheet.models.length >= 40, `expected 40+ live models, saw ${String(sheet.models.length)}`);
    for (const id of ['claude-opus-5.5', 'gpt-6-astra', 'kimi-k3.1-pro', 'deepseek-v4.1-flash']) {
      assert.ok(sheet.models.some((model) => model.id === id), `live catalogue must include ${id}`);
    }
    assert.ok(sheet.models.every((model) => typeof model.name === 'string' && model.name.length > 0));
  });
}

// ---------------------------------------------------------------------------

console.log(results.join('\n'));
console.log(failures === 0 ? `\n${String(results.length)} checks passed` : `\n${String(failures)} of ${String(results.length)} checks failed`);
process.exit(failures === 0 ? 0 : 1);
