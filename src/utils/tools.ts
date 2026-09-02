import { isWebSearchConfigured } from './llm';

// Tools tagged 'confirm' pause the agent loop and show an approval card in the
// chat before executing. Everything else runs instantly.
export type ToolTier = 'auto' | 'confirm';

export const TOOL_TIERS: Record<string, ToolTier> = {
  run_command: 'confirm',
  delete_file: 'confirm',
  switch_model: 'confirm',
  update_settings: 'confirm',
  desktop_click: 'confirm',
  desktop_drag: 'confirm',
  desktop_type: 'confirm',
  desktop_hotkey: 'confirm'
};

const fn = (name: string, description: string, properties: Record<string, any>, required: string[] = []) => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: { type: 'object', properties, required }
  }
});

const str = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'number', description });
const bool = (description: string) => ({ type: 'boolean', description });

export const SYSTEM_TOOLS = [
  // ── Files & system ────────────────────────────────────────────────────────
  fn('view_file', 'Read a file from disk. Read-only, instant.',
    { path: str('Absolute path to the file.') }, ['path']),
  fn('list_dir', 'List directory contents (names, types, sizes). Read-only, instant.',
    { path: str('Absolute or relative directory path. Defaults to current directory.') }),
  fn('search_files', 'Search file contents across a directory tree (recursive grep). Returns matching lines with file paths and line numbers. Read-only, instant. Skips node_modules/.git/build dirs.',
    {
      query: str('Text to find, or a regular expression when is_regex is true.'),
      path: str('Directory to search. Defaults to current directory.'),
      is_regex: bool('Treat query as a JavaScript regex (default false — plain substring match, case-insensitive).'),
      max_results: num('Stop after this many matches (default 200).')
    }, ['query']),
  fn('write_to_file', 'Create or fully overwrite a file with content. Parent directories are created automatically.',
    {
      path: str('Absolute target file path.'),
      content: str('Full content to write.'),
      overwrite: bool('Overwrite if the file exists (default true).')
    }, ['path', 'content']),
  fn('replace_file_content', 'Replace the FIRST exact occurrence of text in a file. Fails honestly if the target text is not found — then view_file first and retry with exact content.',
    {
      path: str('Absolute target file path.'),
      find: str('Exact existing text to replace.'),
      replace: str('Replacement text.')
    }, ['path', 'find', 'replace']),
  fn('delete_file', 'Permanently delete a file from disk. Requires user approval.',
    { path: str('Absolute path of the file to delete.') }, ['path']),
  fn('run_command', 'Execute a shell/terminal command on the host OS and capture stdout/stderr. Requires user approval — expect a permission card; if denied, continue without retrying it.',
    {
      command: str('The shell command to execute.'),
      cwd: str('Optional working directory for the command.'),
      timeout_ms: num('Kill the process after this many ms (default 120000).')
    }, ['command']),

  // ── Web ───────────────────────────────────────────────────────────────────
  fn('search_web', 'Quick web search via the configured search API. Returns result snippets instantly — much cheaper than driving the browser for simple lookups.',
    {
      query: str('Search query.'),
      limit: num('Number of results (default 5).')
    }, ['query']),

  // ── Embedded browser: virtual input (instant, no permission) ─────────────
  fn('browser_navigate', 'Load a URL in the embedded browser. Bare domains get https:// prepended; non-URLs are treated as a DuckDuckGo search. Waits for the page to settle before returning.',
    { url: str('URL or search phrase.') }, ['url']),
  fn('browser_terminate', 'Stop the current browser session and reset to a blank page. Use when the browser is stuck, unresponsive, or the task is complete and you want a clean slate for the next navigation.', {}),
  fn('browser_click', 'Click an element by Set-of-Mark id (preferred) or viewport coordinates. Supports any mouse button, double/triple clicks and modifier keys.',
    {
      id: num('Set-of-Mark element ID from the last screenshot/observe.'),
      x: num('Viewport X coordinate (used when id is omitted).'),
      y: num('Viewport Y coordinate (used when id is omitted).'),
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default left).' },
      click_count: { type: 'number', enum: [1, 2, 3], description: 'Click count: 1 single, 2 double, 3 triple (default 1).' },
      modifiers: { type: 'array', items: { type: 'string' }, description: 'Held modifiers, e.g. ["control", "shift"].' }
    }),
  fn('browser_mouse_down', 'Press and HOLD a mouse button on an element or point (virtual cursor). Pair with browser_mouse_up. For drags prefer browser_drag.',
    {
      id: num('Set-of-Mark element ID to press on.'),
      x: num('Viewport X (when id omitted).'),
      y: num('Viewport Y (when id omitted).'),
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Default left.' }
    }),
  fn('browser_mouse_up', 'Release a held mouse button at the current position (or move to id/x,y first, then release).',
    {
      id: num('Set-of-Mark element ID to release over.'),
      x: num('Viewport X (when id omitted).'),
      y: num('Viewport Y (when id omitted).'),
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Must match the held button. Default left.' }
    }),
  fn('browser_mouse_move', 'Move the virtual cursor to a point or over an element (hover menus, tooltips, positioning between down/up).',
    {
      id: num('Set-of-Mark element ID to hover.'),
      x: num('Viewport X.'),
      y: num('Viewport Y.')
    }),
  fn('browser_drag', 'Drag from a source to a destination (press → interpolated moves → release). Sources/targets can be Set-of-Mark ids OR coordinates. Works for sliders, sortables, canvas drawing.',
    {
      from_id: num('Source Set-of-Mark element ID.'),
      from_x: num('Source viewport X (when from_id omitted).'),
      from_y: num('Source viewport Y (when from_id omitted).'),
      to_id: num('Destination Set-of-Mark element ID.'),
      to_x: num('Destination viewport X (when to_id omitted).'),
      to_y: num('Destination viewport Y (when to_id omitted).'),
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Default left.' }
    }),
  fn('browser_key', 'Press a single keyboard key on the focused element — Enter, Tab, Escape, arrows, shortcuts like Control+a. States: press (down+up), down (hold), up (release). For typing text use browser_type.',
    {
      key: str("Single key name, e.g. 'Enter', 'Tab', 'Escape', 'ArrowDown', 'a'. Never put a phrase here."),
      modifiers: { type: 'array', items: { type: 'string' }, description: 'e.g. ["control", "shift"]' },
      state: { type: 'string', enum: ['press', 'down', 'up'], description: 'Default press.' }
    }, ['key']),
  fn('browser_type', 'Fill a field: clicks the Set-of-Mark element (if given), clears existing content, types, VERIFIES the text landed, optionally presses Enter. The preferred way to fill any search box or form field.',
    {
      text: str('Text to type.'),
      id: num('Set-of-Mark element ID to focus first. Omit to use the currently focused field.'),
      submit: bool('Press Enter after typing (default false).')
    }, ['text']),
  fn('browser_scroll', 'Scroll the embedded browser. Relative directions ride real wheel events (triggers lazy-loading); "top"/"bottom" jump instantly. Reports resulting scroll position so you know when you hit the end.',
    {
      direction: { type: 'string', enum: ['down', 'up', 'left', 'right', 'top', 'bottom'], description: 'Default down.' },
      amount: num('Pixels for relative scrolling (default 600).'),
      id: num('With up/down/left/right: wheel over this Set-of-Mark element. With top/bottom: scroll this element into view.')
    }),
  fn('browser_fill_form', 'Fill multiple form fields at once by mapping Set-of-Mark IDs to text values.',
    {
      data: { type: 'object', additionalProperties: { type: 'string' }, description: 'Map of Set-of-Mark ID (as string) to the text value to type.' }
    }, ['data']),
  fn('browser_file_upload', 'Upload files to a file input element. Provide absolute paths to the files.',
    {
      id: num('Set-of-Mark element ID of the file input.'),
      files: { type: 'array', items: { type: 'string' }, description: 'Absolute paths to files to upload.' }
    }, ['id', 'files']),
  fn('browser_console_messages', 'Fetch recent console messages from the browser.', {}),
  fn('browser_network_requests', 'Fetch recent network requests from the browser.', {}),
  fn('browser_handle_dialog', 'Accept or dismiss an active JavaScript dialog (alert, confirm, prompt).',
    {
      accept: bool('True to accept, false to dismiss.'),
      promptText: str('Optional text to enter into a prompt dialog.')
    }, ['accept']),

  // ── Embedded browser: observation & internals (instant) ───────────────────
  fn('browser_observe', 'One-call page observation: screenshot with red numbered Set-of-Mark badges + element list + trimmed DOM text + **viewport/scroll metadata** (`meta` object with scroll position, max scroll, viewport size, atTop/atBottom/atLeft/atRight booleans, scrollPercent). Your default way to look at a page.',
    {}),
  fn('browser_screenshot', 'Screenshot of ONLY the embedded browser viewport, annotated with Set-of-Mark IDs. Use browser_observe instead unless you specifically want pixels only.',
    {}),
  fn('browser_get_dom', 'Accessible text/DOM tree of the active page (no screenshot). Cheap structural read.',
    {}),
  fn('browser_evaluate', 'Run JavaScript in the page and get the JSON-safe return value. Either a single expression ("document.title") or statements starting with "return". Read-only usage preferred; avoid infinite loops.',
    {
      script: str('JS expression, or statements beginning with "return".'),
      timeout_ms: num('Give up waiting after this many ms (default 15000).')
    }, ['script']),
  fn('browser_cookies', 'Inspect or manage cookies of the embedded browser session.',
    {
      op: { type: 'string', enum: ['get', 'set', 'delete', 'clear'], description: 'get (all or filtered), set, delete one, clear all.' },
      name: str('Cookie name (set/delete/get filter).'),
      value: str('Cookie value (set).'),
      domain: str('Domain filter (get) or cookie domain (set).'),
      url: str('URL context used when setting (default https://<domain>).'),
      expiration_date: num('Unix seconds expiry for set; omit for session cookie.')
    }, ['op']),
  fn('browser_history', 'Embedded browser navigation history: list entries, go back/forward, or jump to an entry index.',
    {
      op: { type: 'string', enum: ['list', 'back', 'forward', 'goto_index'], description: 'Default list.' },
      index: num('Entry index for goto_index (from list output).')
    }),
  fn('browser_storage', 'Read/write localStorage or sessionStorage of the active page.',
    {
      op: { type: 'string', enum: ['get', 'set', 'remove', 'clear'], description: 'get returns one key or all entries.' },
      type: { type: 'string', enum: ['local', 'session'], description: 'Default local.' },
      key: str('Storage key.'),
      value: str('Value to store (op=set).')
    }, ['op']),
  fn('browser_select_option', 'Select an <option> in a dropdown by value (falls back to matching visible label). Fires change events so frameworks notice.',
    {
      id: num('Set-of-Mark element ID of the <select>.'),
      value: str('Option value or visible label.')
    }, ['id', 'value']),
  fn('browser_wait_for', 'Wait until a CSS selector exists or given text appears anywhere in the page. Cheaper than screenshot-polling loops after clicking things that load async content.',
    {
      selector_or_text: str('CSS selector, or raw text to wait for.'),
      timeout_ms: num('Give up after this many ms (default 8000). Returns found:false rather than erroring.')
    }, ['selector_or_text']),
  fn('find_in_page', 'Find text on the current page using the browser\'s native find. Returns match count and highlights matches in the viewport.',
    { text: str('Text to find.') }, ['text']),
  fn('browser_download', 'Download a URL through the embedded browser session. Saves to the Downloads folder (or save_path). Waits for completion.',
    {
      url: str('Direct file URL to download.'),
      save_path: str('Optional absolute destination file path.')
    }, ['url']),
  fn('browser_set_user_agent', 'Override or reset the embedded browser User-Agent string. Pass empty/omit ua to restore default. Useful when sites serve broken pages to unknown agents.',
    { ua: str("User-Agent string, e.g. Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/126 Safari/537.36. Empty = reset.") }),

  // ── Desktop automation (LAST RESORT — every input action needs approval) ──
  fn('desktop_screenshot', 'Screenshot of the user\'s ENTIRE physical monitor. Use only to scope desktop automation or see things outside the embedded browser. Instant (read-only).',
    {}),
  fn('desktop_click', 'Control the REAL host mouse: move + click at screen coordinates. Requires user approval. Only for targets outside the embedded browser.',
    {
      x: num('Screen X.'), y: num('Screen Y.'),
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Default left.' },
      double: bool('Double-click (default false).')
    }, ['x', 'y']),
  fn('desktop_drag', 'Control the REAL host mouse: drag from one point to another. Requires user approval.',
    {
      from_x: num('Start X.'), from_y: num('Start Y.'),
      to_x: num('End X.'), to_y: num('End Y.')
    }, ['from_x', 'from_y', 'to_x', 'to_y']),
  fn('desktop_type', 'Type into whatever window currently has focus on the host OS. Requires user approval.',
    { text: str('Text to type.') }, ['text']),
  fn('desktop_hotkey', 'Press a system-wide key combination (e.g. control+shift+t) on the host OS. Requires user approval.',
    { keys: { type: 'array', items: { type: 'string' }, description: "Modifier/key names, e.g. ['control','shift','t']." } }, ['keys']),

  // ── Self-modification (requires approval) ─────────────────────────────────
  fn('list_models', 'List every model available across enabled providers. Read-only, instant. Call before switch_model to see valid options.',
    {}),
  fn('get_settings', 'Read your current generation settings (temperature, top_p, thinking level, token limits, context window). Read-only, instant.',
    {}),
  fn('get_model_stats', 'Self-diagnostics: session token usage per model, which models are loaded in local provider memory (VRAM), and your active settings. Use to decide when to switch models or tune parameters. Read-only, instant.',
    {}),
  fn('switch_model', 'Switch YOUR OWN model mid-conversation. Applies from the next reasoning step. Requires user approval.',
    {
      model: str('Model ID exactly as returned by list_models.'),
      provider: str('Provider id to disambiguate identical model ids (optional).')
    }, ['model']),
  fn('update_settings', 'Adjust your own sampling/thinking parameters. Only provided keys change; values are clamped to valid ranges. Requires user approval.',
    {
      temperature: num('0–2 (default 0.7). Lower = more deterministic.'),
      top_p: num('0.01–1 (default 0.95).'),
      thinking_level: { type: 'string', enum: ['off', 'low', 'medium', 'high'], description: 'Reasoning effort. Use off for trivial tasks to respond faster.' },
      thinking_timeout: num('Seconds before thinking is cut short (0 = unlimited).'),
      max_output_length: num('Max tokens per response (256–200000).'),
      context_window: num('Context window size hint in tokens (1024+).')
    }),

  // ── Sub-agents (instant to spawn; sub-agents inherit the approval gate) ───
  fn('spawn_agent', 'Spawn an autonomous sub-agent that works on ONE atomic task with its own context window and tool subset, while you keep orchestrating. It reports back a concise final answer. Use for bulky visual processing (e.g. interpreting Set-of-Mark screenshots), independent research threads, or parallelizable chunks. ONE item per agent — for N retailers/sites spawn N agents in parallel (batch calls). Bundling “1. … 2. … 3. …” into one task will be rejected. Sub-agents cannot spawn further agents and never receive desktop tools.',
    {
      task: str('Precise, self-contained instructions for ONE atomic item. Do not enumerate multiple steps like “1. … 2. … 3. …” — split into separate agents instead. Include everything the sub-agent needs — it cannot see this conversation.'),
      context: str('Optional extra data to hand over (text, URLs, prior findings).'),
      model: str('Model id for the sub-agent (see list_models). Defaults to YOUR current model.'),
      provider: str('Provider id for the model (optional disambiguation).'),
      params: { type: 'object', properties: {
        temperature: num('Override temperature for this run.'),
        top_p: num('Override top_p for this run.'),
        thinking_level: { type: 'string', enum: ['off', 'low', 'medium', 'high'], description: 'off makes cheap/fast workers.' },
        max_output_length: num('Override max response tokens.'),
        context_window: num('Override context window.')
      }, description: 'Parameter overrides applied to this sub-agent only.' },
      label: str('Short human-readable label shown in the UI (e.g. "SoM reader A").'),
      wait_ms: num('If set, block up to this many ms for completion before returning (poll-friendly); otherwise spawn-and-continue.')
    }, ['task']),
  fn('check_agents', 'Check status/results of spawned sub-agents. Optionally block until they finish or time out.',
    {
      agent_ids: { type: 'array', items: { type: 'string' }, description: 'Specific ids; omit for ALL.' },
      wait_ms: num('Block up to this many ms until done (default 0 = snapshot only).')
    }),

  // ── Task system (persistent per chat, LLM-owned) ────────────────────────
  // LLM creates verbose tasks via task_add (clear-before-add), updates via task_update, reads via task_list.
  // Tasks are NOT injected into history; LLM only sees active (queued/running) via task_list.
  // User may Clear-all via sidebar; LLM must NOT expose single-delete to user.
  fn('task_add', 'Create verbose tasks for THIS chat. REPLACES all existing tasks for this chat (clear-before-add). One task per atomic item — NEVER bundle multiple distinct items/retailers/sites as enumerated “1. … 2. … 3. …” inside one description. When asked for N items, create N tasks. Each task must be verbose: description (3-5 sentences), goal, assumptions, acceptanceCriteria (≥2), context (verbatim paths/commands, ≥80 chars). No hard limit on count. Call once after Proceed with all Steps. LLM-owned.',
    {
      tasks: { type: 'array', items: { type: 'object', properties: {
        title: str('Imperative ≤15 words, unique per chat — one atomic item only'),
        description: str('Verbose 3-5 sentences: why + approach + non-obvious details (≥120 chars). Do not enumerate multiple items like “1. … 2. … 3. …”'),
        goal: str('Slice of plan Goal this task fulfills'),
        assumptions: { type: 'array', items: { type: 'string' }, description: 'A-refs from plan, e.g. ["A1","A2"]' },
        acceptanceCriteria: { type: 'array', items: { type: 'string' }, description: '≥2 observable checkboxes, e.g. "file X exists && tests pass"' },
        toolHint: { type: 'string', enum: ['files','browser','shell','mixed','none'], description: 'Primary tool family' },
        context: str('Verbatim copy-paste ready: file paths, URLs, command snippets, example I/O (≥80 chars)'),
        dependsOn: { type: 'array', items: { type: 'string' }, description: 'Titles or ids of predecessor tasks' }
      }, required: ['title','description','goal','acceptanceCriteria','context'] } }
    }, ['tasks']),
  fn('task_update', 'LLM-only: advance YOUR task status. Mark done ONLY when acceptanceCriteria met. Requires resultSummary on done/error.',
    {
      taskId: str('Task id from task_add/task_list'),
      status: { type: 'string', enum: ['queued','running','done','error'], description: 'Running when starting, done/error when finished' },
      resultSummary: str('≤160 chars: what was accomplished/found, on done/error')
    }, ['taskId','status']),
  fn('task_list', 'List tasks for this chat. Returns ONLY active (queued/running) by default to avoid context bleed from old done tasks; use includeDone to see all. Read-only.',
    {
      includeDone: bool('If true, includes done/error tasks (rarely needed). Default false.')
    }),

  // ── User interaction ─────────────────────────────────────────────────────
  fn('ask_user', 'Ask the user a question or request permission. BLOCKS until the user responds — you cannot act until then. The user sees your question with your options as multiple-choice buttons plus a free-text "custom response" field (always available, not listed in options). Use for: permission to continue, choices between approaches, checkpoints where the user must do something first (e.g. solve a captcha — offer an option like "I\'m done"). Multi-step forms: batch SEVERAL ask_user calls in ONE turn (they queue up as 1-of-N with prev/next navigation); use separate sequential calls instead when later questions depend on earlier answers.',
    {
      question: str('The question or permission request, shown as the prompt title.'),
      detail: str('Optional technical detail shown in a mono block (command, URL, code snippet…).'),
      options: { type: 'array', items: { type: 'string' }, description: 'REQUIRED — at least one CONCRETE clickable answer (standard approval flow: ["Proceed"]). Free-text is always available to the user additionally.' }
    }, ['question', 'options'])
];

// Tools exposed to the model. search_web is only included when a search
// provider endpoint is configured; otherwise the model is expected to use
// the embedded browser tools to search.
export const getSystemTools = (role: 'orchestrator' | 'subagent' = 'orchestrator') => {
  let tools = isWebSearchConfigured() ? SYSTEM_TOOLS : SYSTEM_TOOLS.filter(t => t.function.name !== 'search_web');
  if (role === 'orchestrator') {
    // Orchestrator thinks and delegates: no direct browser manipulation
    tools = tools.filter(t => !t.function.name.startsWith('browser_'));
  } else if (role === 'subagent') {
    // Sub-agents do not manage tasks, settings, or spawn more agents
    const restricted = ['spawn_agent', 'check_agents', 'task_add', 'task_update', 'task_list', 'list_models', 'switch_model', 'get_settings', 'get_model_stats', 'update_settings'];
    tools = tools.filter(t => !restricted.includes(t.function.name));
  }
  return tools;
};
