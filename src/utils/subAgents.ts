import { generateChatStream, getModelSettings, condenseThinking, stripSimulatedDebris, LLMModel, ModelSettings, fetchModels, getVramReport, estimateModelVram } from './llm';
import { executeToolCalls, ToolContext } from './toolExecutor';
import { getSystemTools } from './tools';
import { buildSubAgentPrompt } from './prompts';
import { taskListStore } from './taskListStore';
import { chatStore, transcriptToMessages } from './chatStore';

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
  // Parent chat for the agent's persisted nested chat (the orchestrator's
  // chat, or the spawner agent's own nested chat for depth-2 agents).
  parentChatId?: string | null;
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
  // Only this agent's own turns — never its children's internals.
  transcript: TranscriptEntry[];
  // Persisted nested chat backing this agent's transcript.
  chatId?: string;
  // True once the worker checked off its own task via complete_task.
  selfCompleted?: boolean;
  // Provider rejected images for this worker — screenshots are stripped.
  visionBroken?: boolean;
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

const truncateForContext = (s: string, max = 6000) =>
  s.length > max ? s.slice(0, max) + `\n...[truncated ${s.length - max} chars]` : s;

// Stream call with one automatic retry for transient failures (connection
// resets, provider hiccups). Abort errors are never retried.
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const generateChatStreamWithRetry = async (...args: Parameters<typeof generateChatStream>): Promise<ReturnType<typeof generateChatStream>> => {
  try {
    return await generateChatStream(...args);
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    console.warn('[subAgents] stream failed once, retrying:', e?.message || e);
    await sleep(700);
    return generateChatStream(...args);
  }
};

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
    transcript: [{ role: 'user', content: spec.context ? `${spec.task}\n\nContext:\n${spec.context}` : spec.task }]
  };
  registry.set(id, state);
  hostMap.set(id, host);
  if (spec.taskId) taskListStore.update(spec.taskId, { agentId: id });
  createNestedChat(state, spec.parentChatId ?? null);
  pumpQueue(hostMap);
  return id;
};

// Every spawned agent gets a persisted nested chat under its parent so the
// conversation survives restarts and renders in the sidebar tree. Falls back
// to a root chat when no parent is known.
const createNestedChat = (state: SubAgentState, parentChatId: string | null): void => {
  void (async () => {
    try {
      const meta = await chatStore.createChat(parentChatId, state.label.slice(0, 80) || 'Sub-agent', state.id);
      state.chatId = meta.id;
      // Persist whatever accumulated before the chat existed.
      await chatStore.saveMessages(meta.id, transcriptToMessages(state.transcript));
    } catch (e) {
      console.error('[subAgents] nested chat creation failed', e);
    }
  })();
};

// Sync an agent's live transcript into its persisted nested chat.
const persistTranscript = (state: SubAgentState, immediate = false): void => {
  const chatId = state.chatId;
  if (!chatId) return;
  const messages = transcriptToMessages(state.transcript);
  if (immediate) void chatStore.saveMessages(chatId, messages);
  else chatStore.saveMessagesDebounced(chatId, messages);
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

const resolveModel = async (spec: SubAgentSpec, host: SubAgentHost, agentLabel: string): Promise<LLMModel> => {
  const wanted = spec.model;
  const fallback = host.getModel();
  if (wanted?.id) {
    const models = await fetchModels();
    const match =
      models.find(m => m.id === wanted.id && (!wanted.provider || m.provider === wanted.provider)) ||
      models.find(m => m.id.toLowerCase() === wanted.id.toLowerCase());
    if (match) {
      // Defense-in-depth against model thrash: an explicit pick that cannot
      // fit beside the resident models falls back to the orchestrator's own
      // (already loaded) model instead of forcing an evict/reload cycle.
      try {
        const report = await getVramReport();
        const need = estimateModelVram(match.id, report);
        if (report.supported && report.headroomBytes != null && need != null && need > report.headroomBytes && fallback) {
          console.warn(`[subAgents] "${agentLabel}" requested ${match.id} (~${(need / 2 ** 30).toFixed(1)} GB) but headroom is ~${((report.headroomBytes || 0) / 2 ** 30).toFixed(1)} GB — inheriting orchestrator model ${fallback.id} instead`);
          return fallback;
        }
      } catch {}
      return match;
    }
  }
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
    const model = await resolveModel(agentParamsOf(agent), host, agent.label);
    agent.model = { id: model.id, provider: model.provider };
    console.log(`[subAgents] "${agent.label}" → model ${model.provider}/${model.id} (preset: ${agent.tools})`);
    if (agent.taskId) {
      taskListStore.update(agent.taskId, { modelLabel: `${model.provider}/${model.id}` });
    }

    const mergedSettings: ModelSettings = { ...getModelSettings(), ...(agent.params || {}) };

    const allowedTools = new Set(TOOL_PRESETS[agent.tools]);
    // A bound worker may check off ONLY its own task via complete_task.
    if (agent.taskId) allowedTools.add('complete_task');
    const toolDefs = getSystemTools().filter(t => allowedTools.has(t.function.name));

    const messages: any[] = [
      { role: 'system', content: buildSubAgentPrompt() },
      { role: 'user', content: agent.context ? `${agent.task}\n\nContext:\n${agent.context}` : agent.task }
    ];

    const pushTurn = (role: TranscriptEntry['role'], content: string) => {
      agent.transcript.push({ role, content });
      if (agent.transcript.length > 400) agent.transcript.splice(0, agent.transcript.length - 400);
      persistTranscript(agent);
    };

    const ctx: ToolContext = {
      requestApproval: host.requestApproval,
      promptTaskId: agent.taskId,
      ownTaskId: agent.taskId,
      agentId: agent.id,
      signal: controller.signal
    };

    let finalContent = '';
    // Auto-recovery: nudge models that stop after thinking without acting or
    // get cut off mid-generation by max_tokens, instead of ending the task.
    let autoContinues = 0;
    // One dedicated nudge when an agent ends naturally without checking its
    // task off — claims of "task complete" in prose are NOT check-offs.
    let completeNudged = false;
    // Flips on after a provider rejects multimodal input for this worker —
    // screenshots stop being injected and poisoned history is scrubbed.
    let visionBroken = false;

    const stripImageParts = () => {
      let removed = 0;
      for (const m of messages) {
        if (Array.isArray(m.content)) {
          const kept = m.content.filter((p: any) => p?.type !== 'image_url');
          removed += m.content.length - kept.length;
          if (kept.length !== m.content.length) {
            // Replace with an explicit note so rounds still make sense.
            kept.push({ type: 'text', text: '[screenshot omitted — this model cannot process images]' });
            m.content = kept;
          }
        }
      }
      return removed;
    };

    let round = 0;
    for (; round < MAX_AGENT_ROUNDS; round++) {
      if (controller.signal.aborted) throw new Error('Aborted by user');

      let res;
      try {
        res = await generateChatStreamWithRetry(model, messages, () => {}, controller.signal, mergedSettings, toolDefs);
      } catch (e: any) {
        const msg = String(e?.message || e);
        if (!visionBroken && /multimodal|image|audio/i.test(msg) && /400|invalid|failed to load/i.test(msg)) {
          // Provider rejected image parts (text-only worker). Scrub every
          // image from the history and retry the round without them.
          agent.visionBroken = true;
          visionBroken = true;
          console.warn(`[subAgents] "${agent.label}" model ${model.id} rejected images — stripping screenshots and retrying`);
          stripImageParts();
          round--; // this attempt doesn't consume budget
          continue;
        }
        throw e;
      }
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
        // Natural end without a check-off: one nudge to actually call
        // complete_task (prose claims don't count).
        if (agent.taskId && !agent.selfCompleted && !completeNudged &&
            !controller.signal.aborted && round < MAX_AGENT_ROUNDS - 1 &&
            (res.content || '').trim()) {
          completeNudged = true;
          pushTurn('assistant', stripSimulatedDebris(res.content) || '');
          messages.push({
            role: 'user',
            content: '[System notice] Your task status is still NOT done — describing completion in text does not count. If your work genuinely satisfies the task, call complete_task(summary="<one-line result>") NOW. Only skip this if something is genuinely unfinished or failed.'
          });
          continue;
        }
        // Record the final answer as its own transcript turn — otherwise the
        // nested chat never shows the sub-agent's closing response.
        if ((res.content || '').trim()) {
          pushTurn('assistant', stripSimulatedDebris(res.content) || res.content);
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
      // The worker checked its own task off — remember it so the runner does
      // not downgrade the task to 'review' when the loop ends.
      if (agent.taskId && taskListStore.find(agent.taskId)?.status === 'done') {
        agent.selfCompleted = true;
      }

      const parts: any[] = [];
      let hasImage = false;
      for (const r of results) {
        parts.push({ type: 'text', text: `<tool_response tool="${r.toolName}"${r.error ? ' error="true"' : ''}>\n${truncateForContext(r.result)}\n</tool_response>` });
        if (r.imageDataUrl && !visionBroken) {
          parts.push({ type: 'text', text: `[${r.toolName} screenshot attached below]` });
          parts.push({ type: 'image_url', image_url: { url: r.imageDataUrl } });
          hasImage = true;
        } else if (r.imageDataUrl && visionBroken) {
          parts.push({ type: 'text', text: `[${r.toolName} captured a screenshot — not shown to you because this model cannot process images. Rely on the DOM text above.]` });
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
      const checkOffHint = agent.taskId && !agent.selfCompleted
        ? ' If your task is genuinely complete, you should have called complete_task — it is too late now; state your result clearly.'
        : '';
      const wrapNotice = round >= MAX_AGENT_ROUNDS
        ? `[System notice] Tool-call budget reached — no further tool calls will execute. Report your findings and the task outcome now, concisely.${checkOffHint}`
        : `[System notice] You stopped without reporting. Based on your tool results, report your findings and the task outcome now, concisely.${checkOffHint}`;
      messages.push({ role: 'user', content: wrapNotice });
      pushTurn('user', wrapNotice);
      const wrapRes = await generateChatStreamWithRetry(model, messages, () => {}, controller.signal, mergedSettings, []);
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
    persistTranscript(agent, true);
    if (agent.taskId) {
      // The agent ending is NOT the task completing. Only the worker's own
      // complete_task call marks it done; a clean finish without one leaves
      // the task in 'review' for the orchestrator to verify.
      const selfDone = taskListStore.find(agent.taskId)?.status === 'done';
      let status: 'done' | 'error' | 'review';
      if (selfDone) status = 'done';
      else if (agent.status === 'error') status = 'error';
      else status = 'review';
      const summary =
        status === 'done'
          ? (taskListStore.find(agent.taskId)?.resultSummary || (agent.result || '').split('\n')[0]).slice(0, 160)
          : status === 'error'
            ? (agent.error || 'failed').slice(0, 160)
            : `finished without check-off: ${(agent.result || '').split('\n')[0].slice(0, 120)}`;
      taskListStore.update(agent.taskId, {
        status,
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

// ─── Approved-plan runner ─────────────────────────────────────────────────────
// The app (not the LLM) drives execution: one task + one agent per approved
// step, spawned in parallel, collected with a global deadline, one automatic
// retry per failure. Progress flows back through taskListStore (the sidebar)
// and the onProgress callback (the chat's delegation timeline).

import { PlanStep, pickWorkerModel } from './delegation';

export interface StepRunUpdate {
  index: number;
  status: 'queued' | 'running' | 'retrying' | 'done' | 'error';
  resultSummary?: string;
  agentId?: string;
  durationMs?: number;
}

export interface StepRunResult extends StepRunUpdate {
  step: PlanStep;
  taskId?: string;
  agentId?: string;
  ok: boolean;
  report: string;
  error?: string;
  durationMs?: number;
  resultSummary?: string;
}

export interface RunStepsHost {
  getModel: () => LLMModel | null;
  requestApproval: (toolName: string, summary: string) => Promise<{ approved: boolean; message?: string }>;
  signal?: AbortSignal;
  parentChatId?: string | null;
  onProgress?: (u: StepRunUpdate) => void;
}

const STEP_DEADLINE_MS = 6 * 60 * 1000;

const composeStepTask = (step: PlanStep): string =>
  [
    step.title,
    step.detail ? `\n${step.detail}` : '',
    '\n\nReport your findings concisely as your final message.'
  ].join('');

export const runApprovedSteps = async (
  steps: PlanStep[],
  host: RunStepsHost
): Promise<StepRunResult[]> => {
  const orchestrator = host.getModel();
  if (!orchestrator) throw new Error('No orchestrator model available for delegation');

  const results: StepRunResult[] = steps.map((step, index) => ({
    step, index, status: 'queued', ok: false, report: ''
  }));

  const spawnFor = async (index: number, isRetry: boolean): Promise<string> => {
    const step = steps[index];
    // Retry always escalates to the orchestrator's model — it is already
    // resident (no swap cost) and typically the most capable option.
    const worker = isRetry ? orchestrator : await pickWorkerModel(step.menial, orchestrator);
    const existingTask = results[index].taskId
      ? taskListStore.find(results[index].taskId!)
      : undefined;
    const taskId =
      existingTask?.id ??
      taskListStore.add([{ title: step.title, detail: step.detail }])[0].id;

    if (isRetry) {
      taskListStore.update(taskId, { status: 'running', endedAt: undefined, resultSummary: undefined });
      host.onProgress?.({ index, status: 'retrying', agentId: undefined });
    }

    const agentId = spawnSubAgent({
      task: composeStepTask(step),
      tools: step.preset,
      label: step.title,
      parentChatId: host.parentChatId ?? null,
      taskId,
      ...(worker.id !== orchestrator.id ? { model: { id: worker.id, provider: worker.provider } } : {})
    }, {
      getModel: () => worker,
      requestApproval: host.requestApproval,
      signal: host.signal
    });

    results[index].taskId = taskId;
    results[index].agentId = agentId;
    return agentId;
  };

  // Initial parallel spawn — spawnSubAgent queues internally beyond the
  // concurrency cap.
  for (let i = 0; i < steps.length; i++) {
    host.onProgress?.({ index: i, status: 'queued' });
    await spawnFor(i, false);
  }

  // Collect with a global deadline.
  const deadline = Date.now() + STEP_DEADLINE_MS;
  await waitForAgents(results.map(r => r.agentId).filter((x): x is string => !!x), STEP_DEADLINE_MS);
  void deadline;

  // Read outcomes; retry each failure exactly once.
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const state = r.agentId ? getAgentsSnapshot([r.agentId])[0] : undefined;
    const failed = !state || state.status === 'error';
    if (!failed) {
      r.status = 'done';
      r.ok = true;
      r.report = state?.result || '';
      r.resultSummary = (state?.result || '').split('\n')[0].slice(0, 140);
      r.durationMs = state && state.startedAt && state.endedAt ? state.endedAt - state.startedAt : undefined;
      host.onProgress?.({ index: i, status: 'done', resultSummary: r.resultSummary, durationMs: r.durationMs, agentId: r.agentId });
    }
  }

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'done') continue;
    if (host.signal?.aborted) break;
    const errText = (() => {
      const s = r.agentId ? getAgentsSnapshot([r.agentId])[0] : undefined;
      return s?.error || 'agent ended without a result';
    })();
    console.warn(`[delegation] step ${i + 1} "${r.step.title}" failed (${errText}) — retrying once`);
    host.onProgress?.({ index: i, status: 'retrying' });
    await spawnFor(i, true);
    const retryId = results[i].agentId;
    if (!retryId) continue;
    await waitForAgents([retryId], STEP_DEADLINE_MS);
    const state = getAgentsSnapshot([retryId])[0];
    if (state && state.status === 'done') {
      r.status = 'done';
      r.ok = true;
      r.report = state.result || '';
      r.resultSummary = (state.result || '').split('\n')[0].slice(0, 140);
      r.durationMs = state.startedAt && state.endedAt ? state.endedAt - state.startedAt : undefined;
      host.onProgress?.({ index: i, status: 'done', resultSummary: r.resultSummary, durationMs: r.durationMs, agentId: r.agentId });
    } else {
      r.status = 'error';
      r.error = state?.error || errText;
      host.onProgress?.({ index: i, status: 'error', resultSummary: r.error });
    }
  }

  return results;
};