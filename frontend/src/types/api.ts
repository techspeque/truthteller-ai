// API contract types — derived from crates/core/src/types.rs

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface StageResult {
  model: string;
  response: string;
  reasoning_details?: string;
  latency_seconds?: number;
  usage?: Usage;
}

export interface RankingResult {
  model: string;
  ranking: string;
  parsed_ranking: string[];
  latency_seconds?: number;
  usage?: Usage;
}

export interface FinalResult {
  model: string;
  response: string;
  reasoning_details?: string;
  latency_seconds?: number;
  usage?: Usage;
}

export interface AttachmentMetadata {
  id: string;
  filename: string;
  size_bytes: number;
  content_type?: string | null;
  extension?: string;
  text_chars?: number;
  context_chars?: number;
  truncated?: boolean;
  preview?: string;
  trace_excerpt?: string;
}

export interface StageTiming {
  stage1?: number;
  stage2?: number;
  stage3?: number;
}

export interface AggregateRanking {
  model: string;
  average_rank: number;
  rankings_count: number;
}

export interface CouncilMetadata {
  label_to_model?: Record<string, string>;
  aggregate_rankings: AggregateRanking[];
  failed_models: string[];
  failed_model_errors?: Record<string, string>;
  timing?: StageTiming;
}

export interface UserMessage {
  role: 'user';
  content: string;
  attachments: AttachmentMetadata[];
}

export type ModelStatus = 'waiting' | 'success' | 'failed';

export interface ModelStatusEntry {
  model: string;
  status: ModelStatus;
  error?: string;
}

export interface AssistantMessage {
  role: 'assistant';
  stage1?: StageResult[] | null;
  stage2?: RankingResult[] | null;
  stage3?: FinalResult | null;
  metadata?: CouncilMetadata | null;
  // Client-side loading state (not persisted)
  loading?: StageLoading;
  timing?: Partial<StageTiming>;
  failedModels?: string[];
  failedModelErrors?: Record<string, string>;
  modelStatuses?: ModelStatusEntry[];
}

export interface StageLoading {
  stage1: boolean;
  stage2: boolean;
  stage3: boolean;
}

export type Message = UserMessage | AssistantMessage;

export interface Conversation {
  id: string;
  created_at: string;
  title?: string | null;
  messages: Message[];
}

export interface ConversationSummary {
  id: string;
  created_at: string;
  title: string;
  message_count: number;
}

export interface CredentialsStatus {
  openrouter_configured: boolean;
  source: string;
  masked_hint?: string | null;
}

export interface AppConfig {
  council_models: string[];
  chairman_model: string;
  request_timeout_seconds: number;
  max_parallel_requests: number;
  retry_attempts: number;
  retry_backoff_ms: number;
  stage2_enabled: boolean;
  stage3_model_override?: string;
  theme: string;
  default_export_format: string;
  insights_expanded_default: boolean;
}

export interface AppConfigResponse extends AppConfig {
  credentials: CredentialsStatus;
}

export interface AvailableModel {
  id: string;
  name: string;
}

export interface StorageInfo {
  runtime?: string;
  data_dir?: string;
  conversations_dir?: string;
  uploads_dir?: string;
  config_path?: string;
  secrets_path?: string;
  logs_dir?: string;
  logs_note?: string;
}

export interface RerunPayload {
  assistant_message_index: number;
  stage: string;
  include_models?: string[];
  chairman_model?: string | null;
}

export interface RerunResponse {
  assistant_message: AssistantMessage;
  assistant_message_index: number;
}
