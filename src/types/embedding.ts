export interface Embedding {
  object: "embedding";
  index: number;
  embedding: number[] | string;
  [key: string]: unknown;
}

export interface EmbeddingUsage {
  prompt_tokens: number;
  total_tokens: number;
  [key: string]: unknown;
}

export interface CreateEmbeddingResponse {
  object: "list";
  data: Embedding[];
  model: string;
  usage?: EmbeddingUsage;
  [key: string]: unknown;
}

export interface EmbeddingCreateParams {
  model: string;
  input: string | string[];
  dimensions?: number;
  encoding_format?: "float" | "base64";
  [key: string]: unknown;
}
