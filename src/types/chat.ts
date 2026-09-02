// Shared chat data model — persisted to <userData>/chats/<chatId>/messages.json.

export interface ChatComment {
  id: string;
  quote: string;
  text: string;
}

export interface ToolCall {
  id: string;
  name: string;
  args: any;
  status: 'executing' | 'completed' | 'error';
  result?: string;
  raw?: string;
  image?: string;
  timestamp?: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinking?: string;
  // Per-round thinking chunks: parts[i] precedes tool-call round i+1.
  thinkingParts?: string[];
  attachments?: any[];
  isGenerating?: boolean;
  comments?: ChatComment[];
  toolCalls?: ToolCall[];
  isCallingTool?: boolean;
  // Debug-transcript data: generation window, exact model-call context and
  // settings/model snapshot at the time of the response.
  createdAt?: number;
  completedAt?: number;
  internalContext?: any[];
  modelStats?: any;
  // Plan-first flow: draft plan awaiting user annotation/approval before
  // execution. planResolved marks an approved (executed) plan.
  isPlan?: boolean;
  planResolved?: boolean;
}

// Sidebar metadata — index.json holds an array of these.
export interface ChatMeta {
  id: string;
  parentId: string | null;
  title: string;
  createdAt: number;
  updatedAt: number;
  // Reserved for future nesting (sub-agents); currently always null for flat history.
  agentId?: string;
}

// messages.json envelope — tasks are persisted per-chat alongside messages
// (LLM only sees active tasks via task_list; history not injected into context).
import type { TaskNode } from './task';
import type { LLMModel, ModelSettings } from '../utils/llm';

export interface ChatFile {
  version: 1;
  meta: ChatMeta;
  messages: ChatMessage[];
  tasks?: TaskNode[];
  // Persisted chat configuration so reloading restores exact models/parameters
  chatConfig?: {
    orchestratorModel: LLMModel | null;
    subAgentModel: LLMModel | null;
    modelSettings: ModelSettings;
    savedAt: number;
    savedAtIso: string;
  };
  // Top-level timestamps for debug exports
  savedAt?: number;
  savedAtIso?: string;
}
