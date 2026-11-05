import type { QCloudAI, RequestOptions } from "../client.js";
import type {
  Completion,
  CompletionChunk,
  CompletionCreateParams,
} from "../types/completion.js";
import type { Stream } from "../streaming.js";

export class Completions {
  constructor(private client: QCloudAI) {}

  async create(
    params: CompletionCreateParams & { stream: true },
    options?: RequestOptions,
  ): Promise<Stream<CompletionChunk>>;
  async create(
    params: CompletionCreateParams & { stream?: false },
    options?: RequestOptions,
  ): Promise<Completion>;
  async create(
    params: CompletionCreateParams,
    options?: RequestOptions,
  ): Promise<Completion | Stream<CompletionChunk>>;
  async create(
    params: CompletionCreateParams,
    options?: RequestOptions,
  ): Promise<Completion | Stream<CompletionChunk>> {
    if (params.stream) {
      return this.client._request<Stream<CompletionChunk>>(
        "POST",
        "/completions",
        {
          ...options,
          body: params,
          stream: true,
        },
      );
    }
    return this.client._request<Completion>("POST", "/completions", {
      ...options,
      body: params,
    });
  }
}
