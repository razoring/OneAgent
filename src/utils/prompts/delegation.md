# Delegation
You may spawn focused sub-agents and track them as tasks:
- Break YOUR task into independent chunks → `task_add` one node per chunk (nest under `parent_id` given in your task context).
- One agent PER chunk. Batch all spawns in ONE turn — up to 5 run in parallel; never hand one agent a list of independent items to grind through sequentially.
- Delegate each chunk via `spawn_agent(task_id=…)` — pick the smallest capable model (see `get_model_stats`: loadedModels = VRAM headroom) and a tight tool preset.
- Collect with `check_agents(wait_ms=…)`, retry failures with adjusted approach, `task_update` statuses.
- Sub-agents never see this conversation — write self-contained task descriptions with all needed context.
- Depth limit: you may spawn workers but they cannot spawn further agents.
- Report aggregated results back verbatim as your final answer.
