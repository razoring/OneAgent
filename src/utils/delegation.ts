// Guided delegation micro-calls: intent classification and plan→steps
// extraction. Deliberately tiny, single-purpose prompts — these run on the
// same (possibly small) local model, so each does exactly one job.
import { LLMModel, generateChatResponse, getVramReport, estimateModelVram } from './llm';

export type StepPreset = 'general' | 'browser' | 'web' | 'files' | 'observe';
const PRESETS: StepPreset[] = ['general', 'browser', 'web', 'files', 'observe'];

export interface PlanStep {
  title: string;
  detail?: string;
  preset: StepPreset;
  menial: boolean;
}

const clampText = (s: unknown, max: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Does answering the user require real-world execution (browsing, files,
 * commands, fresh data)? Returns null when the classification call fails —
 * callers apply a heuristic fallback.
 */
export const classifyNeedsExecution = async (
  model: LLMModel,
  userText: string,
  draft: string
): Promise<boolean | null> => {
  try {
    const out = await generateChatResponse(
      model,
      [
        {
          role: 'system',
          content:
            'You classify requests. Reply with EXACTLY one word: "EXECUTION" or "CHAT".\n' +
            'EXECUTION — fulfilling the request needs real-world actions or CURRENT data: browsing websites, fetching live prices/news/weather, reading/writing files, running commands.\n' +
            'CHAT — answerable purely from existing knowledge or the conversation (explanations, opinions, math, writing, coding advice, definitions).'
        },
        { role: 'user', content: `Request: ${clampText(userText, 600)}\n\nAssistant draft reply:\n${clampText(draft, 800)}` }
      ],
      { temperature: 0, maxOutputLength: 10, thinkingLevel: 'off' } as any
    );
    const cleaned = out.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    if (/^execution\b/i.test(cleaned)) return true;
    if (/^chat\b/i.test(cleaned)) return false;
    return null;
  } catch {
    return null;
  }
};

// Heuristic fallback when the classifier is unavailable: strong execution
// signals beat weak chat signals.
const STRONG_EXEC = /(browse|scrape|fetch|latest|current price|today'?s|news|weather|stock|ticker|download|upload|visit|open the|look up|search (the )?(web|internet)|https?:\/\/)/i;

export const heuristicNeedsExecution = (userText: string, draft: string): boolean =>
  STRONG_EXEC.test(`${userText}\n${draft}`);

/** Convert an approved natural-language plan into concrete delegable steps. */
export const extractSteps = async (model: LLMModel, planText: string): Promise<PlanStep[]> => {
  const sys =
    'Convert the approved plan into JSON for automatic delegation. Output ONLY valid JSON, no prose:\n' +
    '{"steps":[{"title":"short imperative step name (max 8 words)","detail":"fully self-contained instructions for a worker agent, including target sites/method (1-3 sentences)","preset":"browser|web|files|general","menial":true|false}]}\n' +
    'preset guide: browser = interactive sites (click/type/overlays), web = search + read pages, general = everything else.\n' +
    'menial = simple fetch/extract/single-page work (true) vs multi-source analysis or judgment (false).\n' +
    'Merge duplicates. Maximum 6 steps.';
  try {
    const raw = await generateChatResponse(
      model,
      [
        { role: 'system', content: sys },
        { role: 'user', content: clampText(planText, 4000) }
      ],
      { temperature: 0, maxOutputLength: 900, thinkingLevel: 'off' } as any
    );
    const jsonMatch = /\{[\s\S]*\}/.exec(raw.replace(/<think>[\s\S]*?<\/think>/g, ''));
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const steps = normalizeSteps(parsed?.steps);
      if (steps.length > 0) return steps;
    }
  } catch { /* fall through to regex */ }
  return fallbackParse(planText);
};

function normalizeSteps(raw: any): PlanStep[] {
  if (!Array.isArray(raw)) return [];
  const out: PlanStep[] = [];
  for (const r of raw.slice(0, 6)) {
    const title = clampText(r?.title, 80);
    if (!title) continue;
    const presetRaw = clampText(r?.preset, 12).toLowerCase() as StepPreset;
    out.push({
      title,
      detail: r?.detail ? clampText(r.detail, 500) : undefined,
      preset: PRESETS.includes(presetRaw) ? presetRaw : 'general',
      menial: r?.menial !== false
    });
  }
  return out;
}

// Regex fallback: numbered/bulleted lines become steps.
function fallbackParse(planText: string): PlanStep[] {
  const steps: PlanStep[] = [];
  const re = /^\s*(?:\d+[.)]|[-*•])\s+(.{6,140})$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(planText)) !== null && steps.length < 6) {
    const line = clampText(m[1], 120);
    if (!line) continue;
    steps.push({
      title: line.split(/[.:—–-]/)[0].slice(0, 60) || line.slice(0, 60),
      detail: line,
      preset: /news|headline/i.test(line) ? 'web' : /price|finance|stock|market/i.test(line) ? 'browser' : 'general',
      menial: true
    });
  }
  return steps;
}

/**
 * Worker-model policy: menial steps offload to the largest local model that
 * fits entirely within free VRAM headroom beside the orchestrator (no evict/
 * reload thrash). Everything else inherits the orchestrator's model.
 */
export const pickWorkerModel = async (menial: boolean, orchestrator: LLMModel): Promise<LLMModel> => {
  if (!menial) return orchestrator;
  try {
    const report = await getVramReport();
    if (!report.supported || report.headroomBytes == null) return orchestrator;
    const { fetchModels } = await import('./llm');
    const all = await fetchModels();
    const orchEst = estimateModelVram(orchestrator.id, report);
    // Only ALREADY-LOADED smaller models are eligible: offloading to an
    // unloaded model forces a load/evict cycle (the thrash we are avoiding),
    // and tiny unloaded picks can also be too weak for web work.
    const isLoaded = (id: string) =>
      Object.values(report.loadedModels).some(list => list.some(l => String(l.id).toLowerCase() === id.toLowerCase()));
    const candidates = all
      .filter(m => report.loadedModels[m.provider] !== undefined)
      .map(m => ({ m, est: estimateModelVram(m.id, report) }))
      .filter(x => x.est != null && x.est <= report.headroomBytes!)
      .filter(x => isLoaded(x.m.id))
      .filter(x => orchEst == null || x.est! < orchEst * 0.9) // strictly smaller than the orchestrator
      .sort((a, b) => a.est! - b.est!);
    const pick = candidates.find(c => c.m.id.toLowerCase() !== orchestrator.id.toLowerCase());
    if (pick) {
      console.log(`[delegation] menial step → worker ${pick.m.provider}/${pick.m.id} (~${(pick.est! / 2 ** 30).toFixed(1)}GB, loaded, fits headroom)`);
      return pick.m;
    }
    console.log('[delegation] no suitable smaller LOADED worker — steps inherit the orchestrator model');
  } catch { /* best effort */ }
  return orchestrator;
};
