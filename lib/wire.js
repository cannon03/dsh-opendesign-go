/**
 * Harness request ⇄ OpenAI chat-completions wire translation.
 *
 * OpenDesign Go exposes an OpenAI-compatible `/v1` surface, so this module is a
 * direct projection of the harness vocabulary: text and reasoning blocks, tool
 * calls, tool results, and the sampling scalars the core vocabulary carries.
 * Durable image blocks have no inline representation here, so they become the
 * harness's standard text-only placeholder — honest capability reporting rather
 * than a silent drop.
 *
 * @module dsh-opendesign-go/wire
 */

import { ToolCallId, textOnlyImageText } from '@deepseek-ai/dsh-llm';

/** Concatenate the model-visible text of a block list, projecting images to placeholders. */
export function flattenText(blocks) {
  const parts = [];
  for (const block of blocks ?? []) {
    switch (block?.type) {
      case 'text':
        if (typeof block.text === 'string' && block.text.length > 0) parts.push(block.text);
        break;
      case 'reasoning':
        break;
      case 'image':
        parts.push(textOnlyImageText(block.attachment));
        break;
      case 'file':
        parts.push(`[file ${block.attachment?.name ?? 'attachment'}]`);
        break;
      case 'tool-call':
        break;
      case 'tool-result':
        parts.push(flattenText(block.content));
        break;
      default:
        break;
    }
  }
  return parts.join('\n');
}

/** Render one tool result's model-visible text. */
export function toolResultText(blocks) {
  const text = flattenText(blocks);
  return text.length === 0 ? '(no output)' : text;
}

function isToolResultMessage(message) {
  return message?.source?.kind === 'tool' && message.content?.length === 1 && message.content[0]?.type === 'tool-result';
}

/**
 * Serialize one harness message list into OpenAI wire messages.
 * @param {readonly object[]} messages - the assembled request history, in order.
 * @returns {object[]} wire messages with tool results expanded into their own entries.
 */
export function serializeMessages(messages) {
  const wire = [];
  for (const message of messages ?? []) {
    if (message.role === 'system') {
      const text = flattenText(message.content);
      if (text.length > 0) wire.push({ role: 'system', content: text });
      continue;
    }
    if (isToolResultMessage(message)) {
      const block = message.content[0];
      wire.push({ role: 'tool', content: toolResultText(block.content), tool_call_id: String(block.toolCallId) });
      continue;
    }
    if (message.role === 'assistant') {
      const text = flattenText(message.content);
      const reasoning = (message.content ?? [])
        .filter((block) => block?.type === 'reasoning')
        .map((block) => block.text)
        .join('');
      const toolCalls = (message.content ?? [])
        .filter((block) => block?.type === 'tool-call')
        .map((block) => ({ id: String(block.id), type: 'function', function: { name: block.name, arguments: block.arguments } }));
      wire.push({
        role: 'assistant',
        content: text.length > 0 ? text : toolCalls.length > 0 ? null : '',
        ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
        ...(reasoning.length === 0 ? {} : { reasoning_content: reasoning }),
      });
      continue;
    }
    const text = flattenText(message.content);
    wire.push({ role: 'user', content: text });
    for (const block of message.content ?? []) {
      if (block?.type !== 'tool-result') continue;
      wire.push({ role: 'tool', content: toolResultText(block.content), tool_call_id: String(block.toolCallId) });
    }
  }
  return wire;
}

/** Map harness tool schemas onto the wire shape. */
export function serializeTools(tools) {
  if (tools === undefined || tools.length === 0) return [];
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

/**
 * Build the complete OpenAI-compatible request body.
 * @param {object} options - the assembled harness request.
 * @param {{defaultMaxTokens: number, includeUsage?: boolean}} limits - serializer fallbacks.
 * @returns {object} the JSON body for `POST /v1/chat/completions`.
 */
export function serializeRequest(options, limits) {
  const messages = serializeMessages(options.messages);
  const system = typeof options.system === 'string' ? options.system.trim() : '';
  if (system.length > 0 && !messages.some((message) => message.role === 'system')) messages.unshift({ role: 'system', content: system });
  const tools = serializeTools(options.tools);
  const maxTokens = options.maxTokens ?? limits.defaultMaxTokens;
  return {
    model: options.model,
    messages,
    stream: true,
    ...(limits.includeUsage === false ? {} : { stream_options: { include_usage: true } }),
    ...(tools.length === 0 ? {} : { tools }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
    ...(options.stop === undefined || options.stop.length === 0 ? {} : { stop: options.stop }),
    ...(options.reasoningEffort === undefined ? {} : { reasoning_effort: String(options.reasoningEffort) }),
  };
}

function asNonEmptyString(value) {
  if (typeof value !== 'string') return undefined;
  return value.length > 0 ? value : undefined;
}

function asCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Map wire token counters onto the harness's disjoint usage vocabulary.
 * @param {object} usage - the provider's `usage` object.
 * @returns {{usage: object, cost?: number}} harness usage and the provider-reported cost, if any.
 */
export function mapWireUsage(usage) {
  const prompt = asCount(usage?.prompt_tokens);
  const completion = asCount(usage?.completion_tokens);
  const cached = asCount(usage?.prompt_tokens_details?.cached_tokens) ?? asCount(usage?.prompt_cache_hit_tokens);
  const cacheWrite = asCount(usage?.prompt_tokens_details?.cache_write_tokens);
  const reasoning = asCount(usage?.completion_tokens_details?.reasoning_tokens);
  const total = asCount(usage?.total_tokens);
  const inputTokens = Math.max(0, (prompt ?? 0) - (cached ?? 0));
  const combined = (prompt ?? 0) + (completion ?? 0);
  const totalTokens = total !== undefined && (prompt === undefined || completion === undefined || total === combined) ? total : prompt === undefined || completion === undefined ? undefined : combined;
  const cost = typeof usage?.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : undefined;
  return {
    usage: {
      inputTokens,
      outputTokens: completion ?? 0,
      ...(totalTokens === undefined ? {} : { totalTokens }),
      ...(cached === undefined ? {} : { cacheReadTokens: cached }),
      ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
      ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
    },
    ...(cost === undefined ? {} : { cost }),
  };
}

/**
 * Map OpenAI finish reasons onto the harness vocabulary.
 * @param {string} reason - the wire `finish_reason`.
 * @returns {object | undefined} the harness reason, when it is one we model.
 */
export function mapFinishReason(reason) {
  switch (reason) {
    case 'stop':
      return { kind: 'stop' };
    case 'tool_calls':
    case 'function_call':
      return { kind: 'tool-calls' };
    case 'length':
      return { kind: 'max-tokens' };
    case 'content_filter':
      return { kind: 'stop' };
    default:
      return undefined;
  }
}

function assemble(block) {
  switch (block.kind) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'reasoning':
      return { type: 'reasoning', text: block.text };
    case 'tool-call':
      return { type: 'tool-call', id: ToolCallId(block.id), name: block.name, arguments: block.arguments.length > 0 ? block.arguments : '{}' };
    default:
      return { type: 'text', text: '' };
  }
}

/**
 * One attempt's stream translator: deltas stream through immediately, while block
 * closures, usage, and the terminal finish are emitted once the provider sends
 * `[DONE]` — the only point where final tool-call arguments and usage are known.
 */
export class WireTranslator {
  constructor() {
    this.blocks = [];
    this.toolByKey = new Map();
    this.text = undefined;
    this.reasoning = undefined;
    this.finishReason = undefined;
    this.usage = undefined;
    this.cost = undefined;
    this.upstreamLabel = undefined;
  }

  /** Whether any content block was started (used for empty-response detection). */
  get sawContent() {
    return this.blocks.length > 0;
  }

  /** Provider-reported cost so far, when any. */
  get reportedCost() {
    return this.cost;
  }

  /** Provider-reported usage so far, when any. */
  get reportedUsage() {
    return this.usage;
  }

  /** Upstream that served the request, when the provider reported one. */
  get upstream() {
    return this.upstreamLabel;
  }

  /**
   * Fold one provider stream chunk into harness chunks.
   * @param {object} chunk - the parsed provider chunk.
   * @returns {object[]} chunks to yield immediately, in order.
   */
  push(chunk) {
    const out = [];
    const label = asNonEmptyString(chunk?.upstream_label) ?? asNonEmptyString(chunk?.provider);
    if (label !== undefined) this.upstreamLabel = label;
    if (chunk?.usage !== undefined && chunk.usage !== null) {
      const mapped = mapWireUsage(chunk.usage);
      this.usage = mapped.usage;
      if (mapped.cost !== undefined) this.cost = mapped.cost;
    }
    const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : undefined;
    if (choice === undefined) return out;
    const reason = asNonEmptyString(choice.finish_reason);
    if (reason !== undefined) this.finishReason = mapFinishReason(reason);
    const delta = choice.delta;
    if (delta === undefined) return out;

    const content = typeof delta.content === 'string' ? delta.content : undefined;
    if (content !== undefined && content.length > 0) {
      if (this.text === undefined) {
        this.text = { kind: 'text', index: this.blocks.length, text: '' };
        this.blocks.push(this.text);
        out.push({ type: 'block-start', index: this.text.index, blockType: 'text' });
      }
      this.text.text += content;
      out.push({ type: 'text-delta', index: this.text.index, text: content });
    }

    const reasoningText = asNonEmptyString(delta.reasoning_content) ?? asNonEmptyString(delta.reasoning);
    if (reasoningText !== undefined) {
      if (this.reasoning === undefined) {
        this.reasoning = { kind: 'reasoning', index: this.blocks.length, text: '' };
        this.blocks.push(this.reasoning);
        out.push({ type: 'block-start', index: this.reasoning.index, blockType: 'reasoning' });
      }
      this.reasoning.text += reasoningText;
      out.push({ type: 'reasoning-delta', index: this.reasoning.index, text: reasoningText });
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const raw of delta.tool_calls) {
        if (typeof raw !== 'object' || raw === null) continue;
        const key = String(raw.index ?? raw.id ?? this.toolByKey.size);
        let state = this.toolByKey.get(key);
        if (state === undefined) {
          state = { kind: 'tool-call', index: this.blocks.length, id: '', name: '', arguments: '' };
          this.blocks.push(state);
          this.toolByKey.set(key, state);
          out.push({ type: 'block-start', index: state.index, blockType: 'tool-call' });
        }
        const id = asNonEmptyString(raw.id);
        const name = asNonEmptyString(raw.function?.name);
        const args = typeof raw.function?.arguments === 'string' ? raw.function.arguments : '';
        if (id !== undefined && state.id.length === 0) state.id = id;
        if (name !== undefined) state.name = name;
        if (state.id.length === 0) state.id = `call_${String(state.index)}`;
        state.arguments += args;
        out.push({
          type: 'tool-call-delta',
          index: state.index,
          id: ToolCallId(state.id),
          ...(name === undefined ? {} : { name: state.name }),
          argumentsDelta: args,
        });
      }
    }
    return out;
  }

  /**
   * Close every block and emit usage plus the terminal finish.
   * @returns {{chunks: object[], usage?: object, cost?: number, upstreamLabel?: string}} the trailing chunks, in order.
   */
  finish() {
    const chunks = [];
    for (const block of this.blocks) chunks.push({ type: 'block-end', index: block.index, block: assemble(block) });
    if (this.usage !== undefined) chunks.push({ type: 'usage', usage: this.usage });
    const reason =
      this.blocks.length === 0
        ? { kind: 'error', failure: { message: 'OpenDesign Go returned a completed response with no content', code: 'EMPTY_RESPONSE' } }
        : (this.finishReason ?? (this.toolByKey.size > 0 ? { kind: 'tool-calls' } : { kind: 'stop' }));
    chunks.push({ type: 'finish', reason });
    return {
      chunks,
      ...(this.usage === undefined ? {} : { usage: this.usage }),
      ...(this.cost === undefined ? {} : { cost: this.cost }),
      ...(this.upstreamLabel === undefined ? {} : { upstreamLabel: this.upstreamLabel }),
    };
  }
}
