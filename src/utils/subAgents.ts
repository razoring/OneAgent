import { generateChatStream, getModelSettings, condenseThinking, LLMModel, ModelSettings, fetchModels } from './llm';
import { executeToolCalls, ToolContext } from './toolExecutor';
import { getSystemTools } from './tools';
import { browserPreviewStore } from './browserPreviewStore';
import { taskStore } from './taskStore';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SubAgentSpec {
  task: string;
  tools?: string;
  context?: string;
  label?: string;
  model?: { id: string; provider?: string };
  params?: Partial<ModelSettings>;
}

export type SubAgentStatus = 'queued' | 'running' | 'done' | 'error';

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
}

export interface SubAgentHost {
  chatId: string;
  requestApproval: (toolName: string, summary: string) => Promise<{ approved: boolean; message?: string }>;
  getModel: () => LLMModel | null;
  signal?: AbortSignal;
}

// ─── Configuration ───────────────────────────────────────────────────────────

export const MAX_CONCURRENT_AGENTS = 3;
const MAX_AGENT_ROUNDS = 12;

// Whitelists — sub-agents NEVER receive desktop control, shell commands,
// deletion, self-modification or delegation regardless of requested preset.
const TOOL_PRESETS: Record<string, Set<string>> = {
  observe: new Set([
    'browser_observe', 'browser_screenshot', 'browser_get_dom', 'find_in_page'
  ]),
  browser: new Set([
    'browser_navigate', 'browser_go_back', 'browser_terminate', 'browser_click', 'browser_mouse_down',
    'browser_mouse_up', 'browser_mouse_move', 'browser_drag', 'browser_key',
    'browser_type', 'browser_scroll', 'browser_observe', 'browser_screenshot',
    'browser_get_dom', 'browser_evaluate', 'browser_cookies', 'browser_history',
    'browser_storage', 'browser_select_option', 'browser_wait_for',
    'find_in_page', 'browser_download', 'browser_set_user_agent'
  ]),
  files: new Set([
    'view_file', 'list_dir', 'search_files', 'write_to_file', 'replace_file_content'
  ]),
  web: new Set([
    'search_web', 'browser_navigate', 'browser_go_back', 'browser_terminate', 'browser_get_dom',
    'browser_observe', 'browser_click', 'browser_type', 'browser_scroll',
    'browser_wait_for'
  ]),
  general: new Set([
    'view_file', 'list_dir', 'search_files', 'search_web', 'browser_navigate', 'browser_terminate',
    'browser_get_dom', 'browser_observe', 'browser_wait_for', 'find_in_page',
    'get_settings'
  ])
};

const truncateForContext = (s: string, max = 6000) =>
  s.length > max ? s.slice(0, max) + `\n...[truncated ${s.length - max} chars]` : s;

const subAgentPrompt = (preset: string) =>
`You are a focused autonomous sub-agent spawned by an orchestrating main agent.
Your job: fully complete the ONE task you were given, then report findings to the orchestrator.

Process — think, act, verify:
1. Think step-by-step about the task, list assumptions and a 2-3 step plan in your reasoning.
2. Use your tools (${preset} preset) to gather evidence and perform actions. Prefer parallel tool calls where independent.
3. After each tool round, briefly reflect on what the results prove and what remains.
4. Before finishing, verify your acceptance criteria are met; if not, keep working.
5. Your FINAL text response is delivered verbatim to the orchestrator — start with concise verdict (done/partial/failed), then key evidence, exact paths/commands/URLs, and honest gaps.

Rules:
- Work autonomously. Never ask questions — there is no human on this channel.
- If blocked one way, try a reasonable alternative before reporting failure.
- Do not add greetings or meta-commentary about being a sub-agent.
- Stay strictly within task scope. Do not mark done without tool-verified evidence.`;

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
    void runSubAgent(next, hosts.get(next.id)!).finally(() => pumpQueue(hosts));
  }
};

// Spawns a sub-agent. Returns its id immediately; execution starts when a
// concurrency slot frees up. Host wires approvals + default model + aborts.
export const spawnSubAgent = (spec: SubAgentSpec, host: SubAgentHost): string => {
  const id = genId();
  // Auto-upgrade preset: browsing tasks need full browser kit, not just general
  const rawTools = spec.tools && TOOL_PRESETS[spec.tools] ? spec.tools : 'general';
  const taskLower = (spec.task + ' ' + (spec.context || '')).toLowerCase();
  const needsBrowser = /browser|navigate|click|type|scroll|website|webpage|page|search|screenshot|observe/.test(taskLower);
  const effectiveTools = needsBrowser && rawTools === 'general' ? 'browser' : rawTools;
  const state: SubAgentState = {
    id,
    label: spec.label || spec.task.slice(0, 40),
    task: spec.task,
    context: spec.context,
    tools: effectiveTools,
    status: 'queued',
    model: spec.model,
    params: spec.params,
    steps: 0
  };
  registry.set(id, state);
  hostMap.set(id, host);
  
  // Link to an existing orchestrator task if one matches this sub-agent's assignment,
  // otherwise create a minimal task so the RightSidebar shows worker progress.
  const existing = taskStore.get(host.chatId).find(t =>
    !t.agentId && (t.title.toLowerCase() === state.label.toLowerCase() || t.title.toLowerCase().includes(state.label.toLowerCase().slice(0, 20)))
  );
  if (existing) {
    taskStore.update(host.chatId, existing.id, { agentId: id });
  } else {
    // No matching orchestrator task (e.g., direct spawn without task_add) — create a linked task
    taskStore.add(host.chatId, {
      title: state.label,
      description: state.task,
      goal: spec.context || '',
      toolHint: state.tools === 'browser' ? 'browser' : state.tools === 'files' ? 'files' : 'mixed',
      agentId: id,
      assumptions: [],
      acceptanceCriteria: [],
      context: spec.context || '',
      dependsOn: []
    });
  }

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
  agent.startedAt = Date.now();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (host.signal) {
    if (host.signal.aborted) controller.abort();
    else host.signal.addEventListener('abort', onAbort, { once: true });
  }

  // Sync task status to running
  taskStore.updateByAgent(host.chatId, agent.id, { status: 'running' });

  try {
    const model = await resolveModel(agentParamsOf(agent), host);
    agent.model = { id: model.id, provider: model.provider };

    const base = getModelSettings();
    const mergedSettings: ModelSettings = { ...base, ...(agent.params || {}) };
    // Sub-agents should actually think — inherit orchestrator level but never stay 'off' unless explicitly asked for cheap workers
    const wantsOff = agent.params?.thinkingLevel === 'off' || (agent.tools === 'observe' && !agent.params?.thinkingLevel);
    if (!wantsOff && (!mergedSettings.thinkingLevel || mergedSettings.thinkingLevel === 'off')) {
      mergedSettings.thinkingLevel = base.thinkingLevel && base.thinkingLevel !== 'off' ? base.thinkingLevel : 'medium';
    }
    // Browser sub-agents need higher token budget and patience for multi-step browsing
    if (agent.tools === 'browser' && !agent.params?.maxOutputLength) {
      mergedSettings.maxOutputLength = Math.max(mergedSettings.maxOutputLength || 4096, 8192);
    }
    const toolDefs = getSystemTools('subagent').filter(t => TOOL_PRESETS[agent.tools].has(t.function.name));

    const messages: any[] = [
      { role: 'system', content: subAgentPrompt(agent.tools) },
      { role: 'user', content: agent.context ? `${agent.task}\n\nContext:\n${agent.context}` : agent.task }
    ];

    const ctx: ToolContext = {
      getModel: () => model,
      setModel: () => { /* sub-agents cannot switch models */ },
      requestApproval: host.requestApproval,
      spawnAgent: () => '',
      getAgents: () => [],
      waitForAgents: async () => [],
      chatId: host.chatId,
      agentId: agent.id,
      signal: controller.signal
    };

    let finalContent = '';
    // Auto-recovery: nudge models that stop after thinking without acting or
    // get cut off mid-generation by max_tokens, instead of ending the task.
    let autoContinues = 0;
    // Function-scoped so the budget-exhaustion check below can read it: it
    // only equals MAX_AGENT_ROUNDS if the loop ran out without breaking early.
    let round = 0;
    for (; round < MAX_AGENT_ROUNDS; round++) {
      if (controller.signal.aborted) throw new Error('Aborted by user');

      const res = await generateChatStream(model, messages, () => {}, controller.signal, mergedSettings, toolDefs);
      finalContent = res.content || finalContent;

      const rawCalls = res.toolCalls || [];
      if (rawCalls.length === 0) {
        const truncated = res.finishReason === 'length';
        const wentSilent = !(res.content || '').trim() && !!(res.thinking || '').trim();
        const contentLen = (res.content || '').trim().length;
        const finalLen = (finalContent || '').trim().length + contentLen;
        const usedTools = agent.steps > 0;
        const presetNeedsTools = agent.tools !== 'observe';
        const quitTooEarly = presetNeedsTools && !usedTools && contentLen < 250;
        const shortFinal = contentLen > 0 && contentLen < 100 && !usedTools;
        const browsingWithoutInteraction = agent.tools === 'browser' && usedTools && agent.steps === 1 && finalLen < 300;
        const futureTense = /\bwill (notify|report|complete|get back|update you)\b/i.test(res.content || '');
        if ((truncated || wentSilent || quitTooEarly || shortFinal || browsingWithoutInteraction || futureTense) && autoContinues < 3 && round < MAX_AGENT_ROUNDS - 1) {
          autoContinues++;
          const digest = condenseThinking(res.thinking)
            .split('\n').filter(l => !l.startsWith('[Earlier')).join('\n').trim();
          let reason = truncated ? 'Your reply hit the token limit mid-generation.'
            : wentSilent ? 'Your reasoning ended without a tool call or answer.'
            : quitTooEarly ? 'You tried to finish without using required tools or evidence.'
            : futureTense ? 'Do not promise future work — you must complete the task NOW in this session. No follow-ups.'
            : browsingWithoutInteraction ? 'You spawned/observed a browser but did no browsing (no click/type/navigate). Continue the browsing task.'
            : 'Your final answer was too short to prove completion.';
          if (agent.tools === 'browser' && !futureTense && contentLen < 200) {
            reason += ' For browser tasks you must do: observe → act (click/type/navigate) → observe → repeat until done. A single observe is never enough.';
          }
          messages.push({
            role: 'user',
            content: `[System notice] ${reason} The task is not done. You must use tools to gather evidence before reporting.${digest ? `\nConclusions already reached (trust these):\n${digest}` : ''} Respond with your next tool call now (or a substantive ≥200-char report with evidence if truly blocked).`
          });
          continue;
        }
        // If we have a short answer but never verified, force one more evidence round
        if (contentLen < 150 && usedTools && autoContinues < 1) {
          autoContinues++;
          messages.push({
            role: 'user',
            content: '[System notice] Your report is too brief to satisfy the task. Expand with exact evidence (paths, excerpts, tool outputs, observed page details) before finishing.'
          });
          continue;
        }
        // Future-tense check for already tool-using agents
        if (futureTense && autoContinues < 2) {
          autoContinues++;
          messages.push({
            role: 'user',
            content: '[System notice] Do not use future tense. You must deliver the actual findings now, not promise to notify later. Continue working and report results immediately.'
          });
          continue;
        }
        break;
      }

      const results = await executeToolCalls(rawCalls, ctx);
      agent.steps += rawCalls.length;

      const parts: any[] = [];
      let hasImage = false;
      for (const r of results) {
        parts.push({ type: 'text', text: `<tool_response tool="${r.toolName}"${r.error ? ' error="true"' : ''}>\n${truncateForContext(r.result)}\n</tool_response>` });
        if (r.imageDataUrl) {
          parts.push({ type: 'text', text: `[${r.toolName} screenshot attached below]` });
          parts.push({ type: 'image_url', image_url: { url: r.imageDataUrl } });
          browserPreviewStore.addImage(agent.id, r.imageDataUrl);
          hasImage = true;
        }
      }

      // Persist this round's reasoning (condensed) into the next round's
      // context so running analysis survives between tool calls.
      const roundDigest = condenseThinking(res.thinking);
      messages.push({
        role: 'assistant',
        content: (roundDigest ? `<reasoning_digest>\n${roundDigest}\n</reasoning_digest>\n\n` : '') +
          rawCalls.map((c: string) => `<tool_call>\n${c}\n</tool_call>`).join('\n\n')
      });
      messages.push({
        role: 'user',
        content: hasImage ? parts : parts.map(pt => pt.text).join('\n\n')
      });
    }

    // Tool budget exhausted: one final tools-free turn so the sub-agent
    // reports its findings instead of ending on a bare tool result.
    if (round >= MAX_AGENT_ROUNDS && !controller.signal.aborted) {
      messages.push({
        role: 'user',
        content: '[System notice] Tool-call budget reached — no further tool calls will execute. Report your findings and the task outcome now, concisely.'
      });
      const wrapRes = await generateChatStream(model, messages, () => {}, controller.signal, mergedSettings, []);
      if ((wrapRes.content || '').trim()) finalContent = wrapRes.content.trim();
    }

    agent.result = finalContent.trim() || '(sub-agent finished with no textual result)';
    agent.status = 'done';
  } catch (e: any) {
    agent.error = e?.name === 'AbortError' ? 'Cancelled by user' : String(e?.message || e);
    agent.status = 'error';
  } finally {
    agent.endedAt = Date.now();
    if (host.signal) host.signal.removeEventListener('abort', onAbort);
    
    // Sync task completion
    taskStore.updateByAgent(host.chatId, agent.id, { 
      status: agent.status,
      resultSummary: agent.status === 'error' ? agent.error : 'Sub-agent completed'
    });
    
    hostMap.delete(agent.id);
  }
};

// spec stored on the state object doubles as the original spec holder.
const agentParamsOf = (agent: SubAgentState): SubAgentSpec => ({
  task: agent.task,
  tools: agent.tools,
  model: agent.model,
  params: agent.params
});

