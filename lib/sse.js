/**
 * Minimal Server-Sent Events reader for the OpenDesign Go stream.
 *
 * Deliberately dependency-free: the harness ships no shared SSE helper for
 * out-of-tree adapters, and the framing needed here (comment lines, `event:`,
 * multi-line `data:`, `[DONE]`) is small enough to own. The reader never
 * interprets payloads; translation lives in `wire.js`.
 *
 * @module dsh-opendesign-go/sse
 */

/**
 * Parse an SSE response body into dispatched messages.
 * @param {ReadableStream<Uint8Array>} body - the response body stream.
 * @returns {AsyncGenerator<{data: string, event?: string}>} one message per blank-line-delimited block.
 */
export async function* readSse(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data = [];
  let event;

  const dispatch = () => {
    if (data.length === 0 && event === undefined) return undefined;
    const message = { data: data.join('\n'), ...(event === undefined ? {} : { event }) };
    data = [];
    event = undefined;
    return message;
  };

  const consumeLine = (line) => {
    if (line.length === 0) return dispatch();
    if (line.startsWith(':')) return undefined;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    return undefined;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const raw = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const message = consumeLine(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
        if (message !== undefined) yield message;
        newline = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      const message = consumeLine(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
      if (message !== undefined) yield message;
    }
    const trailing = dispatch();
    if (trailing !== undefined) yield trailing;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The stream may already be errored; releasing twice is not an error we act on.
    }
  }
}

/**
 * Whether one dispatch is the OpenAI stream terminator.
 * @param {{data: string}} message - the parsed message.
 * @returns {boolean} true for `data: [DONE]`.
 */
export function isDoneMessage(message) {
  return message.data.trim() === '[DONE]';
}
