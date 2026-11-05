import type { CompletionUsage } from "./chat.js";

export interface CompletionChoice {
  index: number;
  text: string;
  finish_reason: string | null;
  logprobs?: unknown;
  [key: string]: unknown;
}

export interface Completion {
  id: string;
  object: "text_completion";
  created: number;
  model: string;
  choices: CompletionChoice[];
  usage?: CompletionUsage;
  system_fingerprint?: string;
  [key: string]: unknown;
}

export interface CompletionChunkChoice {
  index: number;
  text: string;
  finish_reason: string | null;
  logprobs?: unknown;
  [key: string]: unknown;
}

export interface CompletionChunk {
  id: string;
  object: "text_completion";
  created: number;
  model: string;
  choices: CompletionChunkChoice[];
  system_fingerprint?: string;
  [key: string]: unknown;
}

export interface CompletionCreateParams {
  model: string;
  prompt: string;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  [key: string]: unknown;
}
