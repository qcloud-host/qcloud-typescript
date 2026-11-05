export interface ChatCompletionMessage {
  role: string;
  content: string | null;
  tool_calls?: unknown[];
  function_call?: unknown;
  [key: string]: unknown;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatCompletionMessage;
  finish_reason: string | null;
  [key: string]: unknown;
}

export interface CompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  [key: string]: unknown;
}

export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: CompletionUsage;
  system_fingerprint?: string;
  [key: string]: unknown;
}

export interface ChatCompletionChunkDelta {
  role?: string;
  content?: string | null;
  tool_calls?: unknown[];
  function_call?: unknown;
  [key: string]: unknown;
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: ChatCompletionChunkDelta;
  finish_reason: string | null;
  [key: string]: unknown;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
  system_fingerprint?: string;
  [key: string]: unknown;
}

export interface ChatCompletionCreateParams {
  model: string;
  messages: Array<{
    role: string;
    content: string | Array<Record<string, unknown>> | null;
    [key: string]: unknown;
  }>;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  [key: string]: unknown;
}
