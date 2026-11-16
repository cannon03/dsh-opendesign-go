/**
 * The OpenDesign Go adapter: one route, many models, OpenAI-compatible wire.
 *
 * Everything the provider serves arrives through `POST {baseURL}/chat/completions`
 * as an SSE stream, so this adapter owns streaming, cancellation, idle
 * detection, usage accounting, and the mapping from HTTP failures onto the
 * harness's provider-neutral failure codes.
 *
 * @module dsh-opendesign-go/adapter
 */

import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  assertUsableApiKey,
  attributionHeaders,
} from '@deepseek-ai/dsh-llm';
import { isDoneMessage, readSse } from './sse.js';
import { WireTranslator, serializeRequest } from './wire.js';

/** Package name used in credential diagnostics. */
export const PACKAGE_NAME = 'dsh-opendesign-go';

/** Route this adapter serves. */
export const PROVIDER_ID = 'opendesign-go';

const MAX_BODY_SNIPPET = 400;

function snippetOf(text) {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_BODY_SNIPPET);
}

function retryAfterMs(response) {
  const header = response.headers?.get?.('retry-after');
  if (typeof header !== 'string' || header.length === 0) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
  const at = Date.parse(header);
  if (Number.isFinite(at)) {
    const delta = at - Date.now();
    return delta > 0 ? delta : undefined;
  }
  return undefined;
}

/**
 * Map one failed HTTP response onto a harness `LlmError`.
 * @param {object} options - failure facts.
 * @param {Response} options.response - the failed response.
 * @param {string} options.body - its body text.
 * @param {string} options.model - the requested model id.
 * @param {string} options.baseURL - the configured base URL.
 * @returns {LlmError} the failure to throw.
 */
export function providerFailure({ response, body, model, baseURL }) {
  const status = response.status;
  const text = snippetOf(body);
  const detail = text.length === 0 ? '' : ` — ${text}`;
  const where = `${baseURL.replace(/\/+$/, '')} said HTTP ${String(status)}`;
  const request = `OpenDesign Go request for "${model}" (${where})`;
  if (status === 401 || status === 403) {
    return new LlmError(`${request}: the API key was rejected${detail}`, 'AUTH', { status });
  }
  if (status === 402 || /insufficient|quota|balance|credit|billing/i.test(text)) {
    return new LlmError(`${request}: the subscription refused the request for quota or billing reasons${detail}`, 'QUOTA', { status });
  }
  if (status === 429) {
    const after = retryAfterMs(response);
    return new LlmError(`${request}: rate limited${detail}`, 'RATE_LIMIT', {
      status,
      ...(after === undefined ? {} : { providerRetryAfterMs: after }),
    });
  }
  if (status === 404) {
    return new LlmError(`${request}: no such model or endpoint${detail}`, 'MALFORMED_RESPONSE', { status });
  }
  if (status === 413 || /context[ _-]?(length|window)|too many tokens|maximum context/i.test(text)) {
    return new LlmError(`${request}: the request exceeded the model's context window${detail}`, 'CONTEXT_WINDOW_EXCEEDED', { status });
  }
  if (status >= 500) {
    return new LlmError(`${request}: the provider failed to serve the request${detail}`, 'TRANSPORT', { status });
  }
  return new LlmError(`${request}: the provider rejected the request${detail}`, 'MALFORMED_RESPONSE', { status });
}

/** The OpenDesign Go provider. */
export class OpenDesignGoAdapter extends LlmAdapter {
  /**
   * @param {object} deps - adapter dependencies.
   * @param {() => Promise<object[]>} deps.models - the live catalogue entries.
   * @param {() => Promise<string | undefined>} deps.apiKey - resolves the API key.
   * @param {() => object} deps.settings - live settings snapshot.
   * @param {(level: string, message: unknown) => void} deps.log - logger.
   * @param {typeof fetch} [deps.fetchImpl] - injectable fetch, for tests.
   */
  constructor(deps) {
    super();
    this.deps = deps;
  }

  /** Route facts shown by the GUI. */
  providerInfo(provider) {
    return { id: provider, name: 'OpenDesign Go' };
  }

  /**
   * Every model the subscription lists, with prices when the public sheet has them.
   * @param {string} provider - the route being queried.
   * @returns {Promise<object[]>} harness model info entries.
   */
  async listModels(provider) {
    const models = await this.deps.models();
    return models.map((entry) => ({
      provider,
      id: entry.id,
      name: entry.name,
      ...(entry.description === undefined ? {} : { description: entry.description }),
      inputModalities: entry.inputModalities ?? ['text'],
    }));
  }

  /**
   * Per-model facts used by the picker and the context-window guard.
   * @param {string} provider - the route being queried.
   * @param {string} model - the model id.
   * @returns {Promise<object>} harness model info.
   */
  async resolveModel(provider, model) {
    const settings = this.deps.settings();
    const models = await this.deps.models();
    const entry = models.find((candidate) => candidate.id === model);
    const contextWindow = entry?.contextWindow ?? settings.contextWindow;
    const efforts = entry?.reasoningEfforts ?? [];
    return {
      provider,
      id: model,
      name: entry?.name ?? model,
      ...(entry?.description === undefined ? {} : { description: entry.description }),
      inputModalities: entry?.inputModalities ?? ['text'],
      context: { contextWindow: Math.max(1, Math.trunc(contextWindow)) },
      defaultMaxTokens: Math.max(1, Math.trunc(entry?.maxTokens ?? settings.defaultMaxTokens)),
      ...(efforts.length === 0
        ? {}
        : {
            reasoning: {
              efforts: efforts.map((level) => ({
                id: ReasoningEffortId(level),
                name: level.charAt(0).toUpperCase() + level.slice(1),
              })),
            },
          }),
    };
  }

  /** Freeze the settings a prepared call runs with. */
  async prepareCall(provider, model, signal) {
    const info = await this.resolveModel(provider, model, signal);
    return { model: info, stream: (options) => this.stream(options) };
  }

  /**
   * Stream one completion.
   * @param {object} options - the harness request.
   * @returns {AsyncIterable<object>} harness stream chunks.
   */
  async *stream(options) {
    const settings = this.deps.settings();
    const ref = settings.apiKeyEnv;
    const raw = await this.deps.apiKey();
    if (raw === undefined || raw.length === 0) {
      throw new LlmError(
        `OpenDesign Go needs an API key: open Settings → Models, choose OpenDesign Go, paste a key from https://open-design.ai/cloud/api-keys, then Save (stored as ${ref}).`,
        'MISSING_CREDENTIAL',
      );
    }
    const apiKey = assertUsableApiKey(raw, PACKAGE_NAME, ref);
    const baseURL = String(settings.baseURL).replace(/\/+$/, '');
    let body = serializeRequest(options, {
      defaultMaxTokens: settings.defaultMaxTokens,
      includeUsage: settings.includeUsage,
    });

    const controller = new AbortController();
    let timedOut = false;
    let idleTimer;
    const armIdle = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error('OpenDesign Go stream idle timeout'));
      }, settings.requestIdleTimeoutMs);
      idleTimer.unref?.();
    };
    const signal = options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal]);

    const send = (payload) =>
      this.fetchImpl()(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${apiKey}`,
          ...attributionHeaders(),
        },
        body: JSON.stringify(payload),
        signal,
      });

    try {
      let response = await send(body);
      if (!response.ok) {
        const first = await response.text();
        // Some OpenAI-compatible gateways reject `stream_options`; retry once
        // without it rather than failing a call the provider would otherwise serve.
        if (response.status === 400 && body.stream_options !== undefined && /stream_options/i.test(first)) {
          this.deps.log('debug', 'OpenDesign Go rejected stream_options; retrying without usage streaming');
          const { stream_options: _dropped, ...rest } = body;
          body = rest;
          response = await send(body);
          if (!response.ok) throw providerFailure({ response, body: await response.text(), model: options.model, baseURL });
        } else {
          throw providerFailure({ response, body: first, model: options.model, baseURL });
        }
      }
      if (response.body === null) throw new LlmError('OpenDesign Go returned a streaming response with no body', 'MALFORMED_RESPONSE');
      armIdle();
      const translator = new WireTranslator();
      for await (const message of readSse(response.body)) {
        armIdle();
        if (isDoneMessage(message)) break;
        let parsed;
        try {
          parsed = JSON.parse(message.data);
        } catch (error) {
          throw new LlmError(`OpenDesign Go stream sent malformed JSON: ${message.data.slice(0, 200)}`, 'MALFORMED_RESPONSE', { cause: error });
        }
        if (parsed?.error !== undefined) {
          const detail = typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? JSON.stringify(parsed.error));
          throw new LlmError(`OpenDesign Go stream reported an error: ${snippetOf(String(detail))}`, 'MALFORMED_RESPONSE');
        }
        for (const chunk of translator.push(parsed)) yield chunk;
      }
      const tail = translator.finish();
      for (const chunk of tail.chunks) yield chunk;
    } catch (error) {
      if (timedOut) throw new LlmError(`OpenDesign Go stream was idle for ${String(settings.requestIdleTimeoutMs)}ms`, 'TIMEOUT', { cause: error });
      if (options.signal?.aborted === true) throw new LlmError('OpenDesign Go request aborted by caller', 'ABORTED', { cause: error });
      if (error instanceof LlmError) throw error;
      throw new LlmError(`OpenDesign Go stream from ${baseURL} failed`, 'TRANSPORT', { cause: error });
    } finally {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      controller.abort('OpenDesign Go stream consumer stopped');
    }
  }

  /** The fetch implementation this adapter talks through. */
  fetchImpl() {
    return this.deps.fetchImpl ?? fetch;
  }
}
