import type { QCloudAI, RequestOptions } from "../client.js";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParams,
} from "../types/chat.js";
import type { Stream } from "../streaming.js";

class ChatCompletions {
  constructor(private client: QCloudAI) {}

  async create(
    params: ChatCompletionCreateParams & { stream: true },
    options?: RequestOptions,
  ): Promise<Stream<ChatCompletionChunk>>;
  async create(
    params: ChatCompletionCreateParams & { stream?: false },
    options?: RequestOptions,
  ): Promise<ChatCompletion>;
  async create(
    params: ChatCompletionCreateParams,
    options?: RequestOptions,
  ): Promise<ChatCompletion | Stream<ChatCompletionChunk>>;
  async create(
    params: ChatCompletionCreateParams,
    options?: RequestOptions,
  ): Promise<ChatCompletion | Stream<ChatCompletionChunk>> {
    if (params.stream) {
      return this.client._request<Stream<ChatCompletionChunk>>(
        "POST",
        "/chat/completions",
        {
          ...options,
          body: params,
          stream: true,
        },
      );
    }
    return this.client._request<ChatCompletion>("POST", "/chat/completions", {
      ...options,
      body: params,
    });
  }
}

export class Chat {
  readonly completions: ChatCompletions;

  constructor(client: QCloudAI) {
    this.completions = new ChatCompletions(client);
  }
}
