export { QCloudAI, default } from "./client.js";
export type { ClientOptions, RequestOptions } from "./client.js";
export { SDK_VERSION } from "./client.js";

export {
  QCloudAIError,
  APIError,
  APIResponseValidationError,
  APIConnectionError,
  APITimeoutError,
  AuthenticationError,
  InsufficientCreditsError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from "./error.js";

export { Stream } from "./streaming.js";

export type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionMessage,
  ChatCompletionChoice,
  ChatCompletionChunkChoice,
  ChatCompletionChunkDelta,
  ChatCompletionCreateParams,
} from "./types/chat.js";

export type {
  Completion,
  CompletionChoice,
  CompletionChunk,
  CompletionChunkChoice,
  CompletionCreateParams,
} from "./types/completion.js";

export type {
  CreateEmbeddingResponse,
  Embedding,
  EmbeddingUsage,
  EmbeddingCreateParams,
} from "./types/embedding.js";

export type { Model, ModelList } from "./types/model.js";

export { QCloudAI as QCloud } from "./client.js";
