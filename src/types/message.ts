/** Types for the supported subset of the Anthropic Messages API (`POST /v1/messages`). */

export interface MessageTextBlock {
  type: "text";
  text: string;
}

export interface MessageToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export type MessageContentBlock = MessageTextBlock | MessageToolUseBlock | ({ type: string } & Record<string, unknown>);

export interface MessageUsage {
  input_tokens: number;
  output_tokens: number;
  [key: string]: unknown;
}

export interface Message {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: MessageContentBlock[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: MessageUsage;
  [key: string]: unknown;
}

export type MessageParamContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image"; source: { type: "url"; url: string } | { type: "base64"; media_type: string; data: string } }
      | { type: "tool_use"; id: string; name: string; input: unknown }
      | { type: "tool_result"; tool_use_id: string; content?: string | Array<{ type: "text"; text: string }>; is_error?: boolean }
    >;

export interface MessageParam {
  role: "user" | "assistant";
  content: MessageParamContent;
}

export interface MessageTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface MessageCreateParams {
  model: string;
  max_tokens: number;
  messages: MessageParam[];
  system?: string | Array<{ type: "text"; text: string }>;
  temperature?: number;
  top_p?: number;
  tools?: MessageTool[];
  tool_choice?: { type: "auto" | "any" | "none" } | { type: "tool"; name: string };
  metadata?: { user_id?: string };
  stream?: boolean;
}

/**
 * Named Messages SSE events: `message_start`, `content_block_start`,
 * `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`
 * and `ping`. Fields depend on `type`.
 */
export interface MessageStreamEvent {
  type: string;
  index?: number;
  message?: Message;
  content_block?: MessageContentBlock;
  delta?: Record<string, unknown>;
  usage?: MessageUsage;
  [key: string]: unknown;
}
