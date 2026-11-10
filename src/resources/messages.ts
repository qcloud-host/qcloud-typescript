import type { QCloudAI, RequestOptions } from "../client.js";
import type { Stream } from "../streaming.js";
import type { Message, MessageCreateParams, MessageStreamEvent } from "../types/message.js";

export const ANTHROPIC_VERSION = "2023-06-01";

/**
 * `client.messages` — the supported subset of the Anthropic Messages API.
 *
 * QCloud bridges Messages requests to its verified chat catalog. Thinking,
 * prompt caching, beta headers, documents, server tools, `top_k` and non-empty
 * `stop_sequences` fail with `BadRequestError` before provider dispatch. Exact
 * token counting is not available.
 */
export class Messages {
  constructor(private client: QCloudAI) {}

  async create(params: MessageCreateParams & { stream: true }, options?: RequestOptions): Promise<Stream<MessageStreamEvent>>;
  async create(params: MessageCreateParams & { stream?: false }, options?: RequestOptions): Promise<Message>;
  async create(params: MessageCreateParams, options?: RequestOptions): Promise<Message | Stream<MessageStreamEvent>>;
  async create(params: MessageCreateParams, options?: RequestOptions): Promise<Message | Stream<MessageStreamEvent>> {
    const headers = { "anthropic-version": ANTHROPIC_VERSION, ...options?.headers };
    if (params.stream) {
      return this.client._request<Stream<MessageStreamEvent>>("POST", "/messages", {
        ...options,
        headers,
        body: params,
        stream: true,
        terminal: (event: MessageStreamEvent) => event.type === "message_stop",
      });
    }
    return this.client._request<Message>("POST", "/messages", { ...options, headers, body: params });
  }
}

/** Concatenated text of a Message's `text` content blocks. */
export function messageText(message: Pick<Message, "content">): string {
  return message.content
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("");
}
