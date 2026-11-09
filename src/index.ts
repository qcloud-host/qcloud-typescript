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
export type { QueueCatalog, QueueProfile, QueueDeployment, QueueDeploymentList, QueueRequestParams, QueueDeploymentCreateParams } from "./types/serverless.js";

export { QCloudAI as QCloud } from "./client.js";
export { GenerationJobError, GenerationTimeoutError } from "./resources/generation.js";
export { renderGenerationModelReference } from "./generation-docs.js";
export { GenerationSessionStream } from "./session-stream.js";
export { GenerationFile } from "./download.js";
export type { GenerationDownloadOptions } from "./resources/generation-files.js";
export type { GenerationUploadOptions, GenerationUploadSource } from "./upload.js";
export type { GenerationPollOptions } from "./resources/generation.js";
export type {
  JSONValue, GenerationUploadedFile, GenerationAdmissionPolicy, GenerationModel, GenerationModelList, GenerationModelListParams,
  GenerationSchema, GenerationJobStatus, GenerationBilling, GenerationJob,
  GenerationSubmitParams, GenerationResult, GenerationPendingResult, GenerationSubscription,
  GenerationSession, GenerationSessionStatus, GenerationSessionCreateParams, GenerationSessionConnection, GenerationSessionOffer, GenerationSessionEvent,
  GenerationWebSocketConnection, GenerationWebRTCConnection, GenerationWebRTCSignalingConnection,
} from "./types/generation.js";
