import type { QCloudAI, RequestOptions } from "../client.js";
import type { Model, ModelList } from "../types/model.js";

export class Models {
  constructor(private client: QCloudAI) {}

  async list(options?: RequestOptions): Promise<ModelList> {
    return this.client._request<ModelList>("GET", "/models", options);
  }

  async retrieve(model: string, options?: RequestOptions): Promise<Model> {
    return this.client._request<Model>(
      "GET",
      `/models/${encodeURIComponent(model)}`,
      options,
    );
  }
}
