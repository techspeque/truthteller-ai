// Streaming event types — matches contract.rs event ordering

import type {
  StageResult,
  RankingResult,
  FinalResult,
  CouncilMetadata,
  AttachmentMetadata,
} from './api';

export interface UploadProcessingStartEvent {
  type: 'upload_processing_start';
}

export interface UploadProcessingCompleteEvent {
  type: 'upload_processing_complete';
  attachments?: AttachmentMetadata[];
}

export interface Stage1StartEvent {
  type: 'stage1_start';
  models?: string[];
}

export interface Stage1CompleteEvent {
  type: 'stage1_complete';
  data: StageResult[];
  timing?: number;
  failed_models?: string[];
  failed_model_errors?: Record<string, string>;
}

export interface Stage2StartEvent {
  type: 'stage2_start';
  models?: string[];
}

export interface Stage2CompleteEvent {
  type: 'stage2_complete';
  data: RankingResult[];
  metadata?: CouncilMetadata;
  timing?: number;
}

export interface Stage3StartEvent {
  type: 'stage3_start';
  models?: string[];
}

export interface Stage3CompleteEvent {
  type: 'stage3_complete';
  data: FinalResult;
  timing?: number;
}

export interface TitleCompleteEvent {
  type: 'title_complete';
  data: { title: string };
}

export interface CompleteEvent {
  type: 'complete';
  metadata?: CouncilMetadata;
}

export interface ErrorEvent {
  type: 'error';
  message: string;
}

export type CouncilStreamEvent =
  | UploadProcessingStartEvent
  | UploadProcessingCompleteEvent
  | Stage1StartEvent
  | Stage1CompleteEvent
  | Stage2StartEvent
  | Stage2CompleteEvent
  | Stage3StartEvent
  | Stage3CompleteEvent
  | TitleCompleteEvent
  | CompleteEvent
  | ErrorEvent;

export type CouncilEventType = CouncilStreamEvent['type'];
