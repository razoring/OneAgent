// Role-composed system prompts. Each role loads only what it needs:
//   orchestrator = core + orchestrator (plan writing / result synthesis ONLY)
//   worker       = subagent

import core from './core.md?raw';
import orchestrator from './orchestrator.md?raw';
import subagent from './subagent.md?raw';

export const ORCHESTRATOR_PROMPT = `${core}\n\n${orchestrator}`;

export const buildSubAgentPrompt = (): string => subagent;
