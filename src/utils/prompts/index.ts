// Role-composed system prompts. Each role loads only what it needs:
//   orchestrator = core + orchestrator
//   worker       = core + subagent
//   delegator    = core + subagent + delegation

import core from './core.md?raw';
import orchestrator from './orchestrator.md?raw';
import subagent from './subagent.md?raw';
import delegation from './delegation.md?raw';

export const ORCHESTRATOR_PROMPT = `${core}\n\n${orchestrator}`;

export const buildSubAgentPrompt = (canDelegate: boolean): string =>
  canDelegate
    ? `${subagent}\n\n${delegation}`
    : subagent;
