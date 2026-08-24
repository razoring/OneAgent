import { generateChatStream, getModelSettings, condenseThinking, stripSimulatedDebris, LLMModel, ModelSettings, fetchModels } from './llm';
import { executeToolCalls, ToolContext } from './toolExecutor';
import { getSystemTools } from './tools';
import { buildSubAgentPrompt } from './prompts';
import { taskListStore } from './taskListStore';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SubAgentSpec {
  task: string;
  tools?: string;
  context?: string;
  label?: string;
  model?: { id: string; provider?: string };
  params?: Partial<ModelSettings>;
  // Bind this agent to a formal task (status/timing mirror into the tasklist).
  taskId?: string;
  // Allow spawning further sub-agents + task tools (delegation.md prompt).
  canDelegate?: boolean;
  // Nesting depth: orchestrator-spawned = 1, their children = 2 (max).
  depth?: number;
}

export type SubAgentStatus = 'queued' | 'running' | 'done' | 'error';

export interface TranscriptEntry {
  role: 'user' | 'assistant' | 'system' | 'event';
  content: string;
}

export interface SubAgentState {
  id: string;
  label: string;
  task: string;
  context?: string;
  tools: string;
  status: SubAgentStatus;
  model?: { id: string; provider?: string };
  params?: Partial<ModelSettings>;
  steps: number;
  result?: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  taskId?: string;
  canDelegate?: boolean;
  depth: number;
  // Only this agent's own turns — never its children's internals.
  transcript: TranscriptEntry[];
}

// Host-provided capabilities routed from the orchestrator's ChatArea.
export interface SubAgentHost {
  requestApproval: (toolName: string, summary: string) => Promise<{ approved: boolean; message?: string }>;
  getModel: () => LLMModel | null;
  signal?: AbortSignal;
}

// ─── Configuration ───────────────────────────────────────────────────────────

export const MAX_CONCURRENT_AGENTS = 3;
const MAX_AGENT_ROUNDS = 8;
export const MAX_DELEGATION_DEPTH = 2;

// Whitelists — sub-agents NEVER receive desktop control, shell commands,
// deletion or self-modification regardless of requested preset.
const TOOL_PRESETS: Record<string, Set<string>> = {
  observe: new Set([
    'browser_observe', 'browser_screenshot', 'browser_get_dom', 'find_in_page',
    'ask_user'
  ]),
  browser: new Set([
    'browser_navigate', 'browser_go_back', 'browser_terminate', 'browser_click', 'browser_mouse_down',
    'browser_mouse_up', 'browser_mouse_move', 'browser_drag', 'browser_key',
    'browser_type', 'browser_scroll', 'browser_observe', 'browser_screenshot',
    'browser_get_dom', 'browser_evaluate', 'browser_cookies', 'browser_history',
    'browser_storage', 'browser_select_option', 'browser_wait_for',
    'find_in_page', 'browser_download', 'browser_set_user_agent',
    'ask_user'
  ]),
  files: new Set([
    'view_file', 'list_dir', 'search_files', 'write_to_file', 'replace_file_content',
    'ask_user'
  ]),
  web: new Set([
    'search_web', 'browser_navigate', 'browser_go_back', 'browser_terminate', 'browser_get_dom',
    'browser_observe', 'browser_click', 'browser_type', 'browser_scroll',
    'browser_wait_for',
    'ask_user'
  ]),
  general: new Set([
    'view_file', 'list_dir', 'search_files', 'search_web', 'browser_navigate', 'browser_terminate',
    'browser_get_dom', 'browser_observe', 'browser_wait_for', 'find_in_page',
    'get_settings',
    'ask_user'
  ])
};

// Extra tools granted only to delegating agents.
const DELEGATION_TOOLS = new Set(['spawn_agent', 'check_agents', 'task_add', 'task_update', 'task_list']);

const truncateForContext = (s: string, max = 6000) =>
  s.length > max ? s.slice(0, max) + `\n...[truncated ${s.length - max} chars]` : s;

// ─── Registry & scheduler ────────────────────────────────────────────────────

const registry = new Map<string, SubAgentState>();

const genId = () => 'sa-' + Math.random().toString(36).substring(2, 9);

const runningCount = (): number =>
  Array.from(registry.values()).filter(a => a.status === 'running').length;

const pumpQueue = (hosts: Map<string, SubAgentHost>) => {
  while (runningCount() < MAX_CONCURRENT_AGENTS) {
    const next = Array.from(registry.values()).find(a => a.status === 'queued');
    if (!next) break;
    const host = hosts.get(next.id);
    if (!host) break;
    next.status = 'running';
    next.startedAt = Date.now();
    if (next.taskId) {
      taskListStore.update(next.taskId, { status: 'running', startedAt: next.startedAt });
    }
    void runSubAgent(next, hosts.get(next.id)!).finally(() => pumpQueue(hosts));
  }
};

// Spawns a sub-agent. Returns its id immediately; execution starts when a
// concurrency slot frees up. Host wires approvals + default model + aborts.
export const spawnSubAgent = (spec: SubAgentSpec, host: SubAgentHost): string => {
  const id = genId();
  const state: SubAgentState = {
    id,
    label: spec.label || spec.task.slice(0, 40),
    task: spec.task,
    context: spec.context,
    tools: spec.tools && TOOL_PRESETS[spec.tools] ? spec.tools : 'general',
    status: 'queued',
    model: spec.model,
    params: spec.params,
    steps: 0,
    taskId: spec.taskId,
    canDelegate: !!spec.canDelegate && spec.depth !== undefined && spec.depth < MAX_DELEGATION_DEPTH,
    depth: spec.depth ?? 1,
    transcript: [{ role: 'user', content: spec.context ? `${spec.task}\n\nContext:\n${spec.context}` : spec.task }]
  };
  registry.set(id, state);
  hostMap.set(id, host);
  if (spec.taskId) taskListStore.update(spec.taskId, { agentId: id });
  pumpQueue(hostMap);
  return id;
};

const hostMap = new Map<string, SubAgentHost>();

export const getAgentsSnapshot = (ids?: string[]): SubAgentState[] => {
  const all = ids && ids.length > 0
    ? ids.map(i => registry.get(String(i))).filter(Boolean)
    : Array.from(registry.values());
  return (all as SubAgentState[]).map(a => ({ ...a }));
};

// Full internal transcript of ONE agent — for the sidebar inspect view.
export const getAgentTranscript = (id: string): TranscriptEntry[] =>
  registry.get(id)?.transcript.map(t => ({ ...t })) || [];

const isTerminal = (a: SubAgentState) => a.status === 'done' || a.status === 'error';

// Blocks until the targeted agents finish or the timeout elapses.
export const waitForAgents = async (ids: string[] | undefined, ms: number): Promise<SubAgentState[]> => {
  const deadline = Date.now() + Math.min(300000, Math.max(0, ms));
  while (Date.now() < deadline) {
    const snap = getAgentsSnapshot(ids);
    if (snap.length === 0) break;
    if (snap.every(isTerminal)) return snap;
    await new Promise(r => setTimeout(r, 250));
  }
  return getAgentsSnapshot(ids);
};

// ─── Runner loop ─────────────────────────────────────────────────────────────

const resolveModel = async (spec: SubAgentSpec, host: SubAgentHost): Promise<LLMModel> => {
  const wanted = spec.model;
  if (wanted?.id) {
    const models = await fetchModels();
    const match =
      models.find(m => m.id === wanted.id && (!wanted.provider || m.provider === wanted.provider)) ||
      models.find(m => m.id.toLowerCase() === wanted.id.toLowerCase());
    if (match) return match;
  }
  const fallback = host.getModel();
  if (!fallback) throw new Error('No model available for sub-agent (none specified and orchestrator has none)');
  return fallback;
};

const runSubAgent = async (agent: SubAgentState, host: SubAgentHost): Promise<void> => {
  const controller = new AbortController();
  if (host.signal) {
    if (host.signal.aborted) controller.abort();
    else host.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const model = await resolveModel(agentParamsOf(agent), host);
    agent.model = { id: model.id, provider: model.provider };
    if (agent.taskId) {
      taskListStore.update(agent.taskId, { modelLabel: `${model.provider}/${model.id}` });
    }

    const mergedSettings: ModelSettings = { ...getModelSettings(), ...(agent.params || {}) };

    const allowedTools = new Set(TOOL_PRESETS[agent.tools]);
    if (agent.canDelegate) DELEGATION_TOOLS.forEach(t => allowedTools.add(t));
    const toolDefs = getSystemTools().filter(t => allowedTools.has(t.function.name));

    const messages: any[] = [
      { role: 'system', content: buildSubAgentPrompt(!!agent.canDelegate) },
      ...(agent.depth > 1 ? [{ role: 'system', content: `Delegation depth: ${agent.depth}. You cannot spawn further agents.` }] : []),
      { role: 'user', content: agent.context ? `${agent.task}\n\nContext:\n${agent.context}` : agent.task }
    ];

    const pushTurn = (role: TranscriptEntry['role'], content: string) => {
      agent.transcript.push({ role, content });
      if (agent.transcript.length > 400) agent.transcript.splice(0, agent.transcript.length - 400);
    };

    const ctx: ToolContext = {
      getModel: () => model,
      setModel: () => { /* sub-agents cannot switch models */ },
      requestApproval: host.requestApproval,
      spawnAgent: agent.canDelegate
        ? (spec) => spawnSubAgent(
            { ...spec, depth: agent.depth + 1, taskId: spec.taskId },
            host
          )
        : () => '',
      getAgents: agent.canDelegate ? getAgentsSnapshot : () => [],
      waitForAgents: agent.canDelegate ? waitForAgents : async () => [],
      promptTaskId: agent.taskId,
      signal: controller.signal
    };

    let finalContent = '';
    // Auto-recovery: nudge models that stop after thinking without acting or
    // get cut off mid-generation by max_tokens, instead of ending the task.
    let autoContinues = 0;
    let round = 0;
    for (; round < MAX_AGENT_ROUNDS; round++) {
      if (controller.signal.aborted) throw new Error('Aborted by user');

      const res = await generateChatStream(model, messages, () => {}, controller.signal, mergedSettings, toolDefs);
      finalContent = stripSimulatedDebris(res.content) || finalContent;

      const rawCalls = res.toolCalls || [];
      if (rawCalls.length === 0) {
        const truncated = res.finishReason === 'length';
        const wentSilent = !(res.content || '').trim() && !!(res.thinking || '').trim();
        // Simulated-tool debris in content is not an answer — recover.
        const debrisOnly = !!(res.content || '').trim() && !stripSimulatedDebris(res.content);
        if ((truncated || wentSilent || debrisOnly) && autoContinues < 2 && round < MAX_AGENT_ROUNDS - 1) {
          autoContinues++;
          const digest = condenseThinking(res.thinking)
            .split('\n').filter(l => !l.startsWith('[Earlier')).join('\n').trim();
          messages.push({
            role: 'user',
            content: `[System notice] ${truncated ? 'Your reply hit the token limit mid-generation.' : debrisOnly ? 'You simulated tool execution instead of calling tools — fabricated output is discarded.' : 'Your reasoning ended without a tool call or answer.'} The task is not done.${digest ? `\nConclusions already reached (trust these):\n${digest}` : ''} Respond with your next REAL tool call as <tool_call> JSON now.`
          });
          continue;
        }
        break;
      }

      // Capture this round: reasoning digest + calls, then responses.
      const roundDigest = condenseThinking(res.thinking);
      const assistantContent = (roundDigest ? `<reasoning_digest>\n${roundDigest}\n</reasoning_digest>\n\n` : '') +
        rawCalls.map((c: string) => `<tool_call>\n${c}\n</tool_call>`).join('\n\n');
      messages.push({ role: 'assistant', content: assistantContent });
      pushTurn('assistant', assistantContent);

      const results = await executeToolCalls(rawCalls, ctx);
      agent.steps += rawCalls.length;

      const parts: any[] = [];
      let hasImage = false;
      for (const r of results) {
        parts.push({ type: 'text', text: `<tool_response tool="${r.toolName}"${r.error ? ' error="true"' : ''}>\n${truncateForContext(r.result)}\n</tool_response>` });
        if (r.imageDataUrl) {
          parts.push({ type: 'text', text: `[${r.toolName} screenshot attached below]` });
          parts.push({ type: 'image_url', image_url: { url: r.imageDataUrl } });
          hasImage = true;
        }
      }
      const responseText = hasImage ? JSON.stringify(parts) : parts.map(pt => pt.text).join('\n\n');
      messages.push({ role: 'user', content: hasImage ? parts : responseText });
      pushTurn('user', responseText);
    }

    // One final tools-free turn when the sub-agent would end without a real
    // report: budget exhausted, or tool work happened but no text was produced.
    const needsWrapUp =
      (round >= MAX_AGENT_ROUNDS || (!finalContent.trim() && agent.steps > 0)) &&
      !controller.signal.aborted;
    if (needsWrapUp) {
      const wrapNotice = round >= MAX_AGENT_ROUNDS
        ? '[System notice] Tool-call budget reached — no further tool calls will execute. Report your findings and the task outcome now, concisely.'
        : '[System notice] You stopped without reporting. Based on your tool results, report your findings and the task outcome now, concisely.';
      messages.push({ role: 'user', content: wrapNotice });
      pushTurn('user', wrapNotice);
      const wrapRes = await generateChatStream(model, messages, () => {}, controller.signal, mergedSettings, []);
      if ((wrapRes.content || '').trim()) {
        finalContent = wrapRes.content.trim();
        pushTurn('assistant', finalContent);
      }
    }

    agent.result = finalContent.trim() || '(sub-agent finished with no textual result)';
    agent.status = 'done';
  } catch (e: any) {
    agent.error = e?.name === 'AbortError' ? 'Cancelled by user' : String(e?.message || e);
    agent.status = 'error';
  } finally {
    agent.endedAt = Date.now();
    hostMap.delete(agent.id);
    if (agent.taskId) {
      const summary = agent.status === 'done'
        ? (agent.result || '').split('\n')[0].slice(0, 120)
        : (agent.error || 'failed');
      taskListStore.update(agent.taskId, {
        status: agent.status,
        endedAt: agent.endedAt,
        resultSummary: summary
      });
    }
  }
};

// spec stored on the state object doubles as the original spec holder.
const agentParamsOf = (agent: SubAgentState): SubAgentSpec => ({
  task: agent.task,
  tools: agent.tools,
  model: agent.model,
  params: agent.params
});
