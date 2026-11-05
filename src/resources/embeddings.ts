import type { QCloudAI, RequestOptions } from "../client.js";
import type {
  CreateEmbeddingResponse,
  EmbeddingCreateParams,
} from "../types/embedding.js";

export class Embeddings {
  constructor(private client: QCloudAI) {}

  async create(
    params: EmbeddingCreateParams,
    options?: RequestOptions,
  ): Promise<CreateEmbeddingResponse> {
    return this.client._request<CreateEmbeddingResponse>(
      "POST",
      "/embeddings",
      {
        ...options,
        body: params,
      },
    );
  }
}
