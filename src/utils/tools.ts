import { isWebSearchConfigured } from './llm';

export const SYSTEM_TOOLS = [
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Execute a terminal/shell command on the host OS and return stdout/stderr.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to execute." },
          cwd: { type: "string", description: "Optional current working directory." }
        },
        required: ["command"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "view_file",
      description: "Read the complete text contents of a file on the local filesystem.",
      parameters: {
        type: "object",
        properties: {
          AbsolutePath: { type: "string", description: "Absolute path to the file." }
        },
        required: ["AbsolutePath"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List directory contents (files, folders, sizes).",
      parameters: {
        type: "object",
        properties: {
          DirectoryPath: { type: "string", description: "Path to the directory." }
        },
        required: ["DirectoryPath"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_to_file",
      description: "Create or overwrite a file.",
      parameters: {
        type: "object",
        properties: {
          targetFile: { type: "string", description: "Absolute path to the target file." },
          codeContent: { type: "string", description: "Content to write to the file." },
          overwrite: { type: "boolean", description: "Whether to overwrite if it exists." }
        },
        required: ["targetFile", "codeContent"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "replace_file_content",
      description: "Replace exact text within a file.",
      parameters: {
        type: "object",
        properties: {
          targetFile: { type: "string", description: "Absolute path to the target file." },
          targetContent: { type: "string", description: "Exact text to be replaced." },
          replacementContent: { type: "string", description: "New text to insert." }
        },
        required: ["targetFile", "targetContent", "replacementContent"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "Delete a file on disk.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Absolute path to the file to delete." }
        },
        required: ["filePath"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_web",
      description: "Search the web via the configured search API endpoint and return results. Only available when a search provider is configured in Settings.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query." },
          limit: { type: "number", description: "Number of results to return (default 5)." }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_navigate",
      description: "Load a website into the embedded browser window.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to navigate to." }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_go_back",
      description: "Navigate back in the browser history.",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_get_dom",
      description: "Extract the accessible text/DOM tree of the active webpage.",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_visual_capture",
      description: "Inject Set-of-Mark visual label numbers onto all clickable/input elements on the webpage.",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_interact",
      description: "Click, scroll to, or type text into a labeled browser element ID.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "The element ID from Set-of-Mark." },
          action: { type: "string", enum: ["click", "type", "scroll"], description: "Action to perform." },
          value: { type: "string", description: "Text to type (if action is type)." }
        },
        required: ["id", "action"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "desktop_screenshot",
      description: "Capture a full screenshot of the user's primary monitor.",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },
  {
    type: "function",
    function: {
      name: "desktop_click",
      description: "Move the host OS mouse and click at (x, y) coordinates.",
      parameters: {
        type: "object",
        properties: {
          x: { type: "number", description: "X coordinate." },
          y: { type: "number", description: "Y coordinate." }
        },
        required: ["x", "y"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "desktop_type",
      description: "Type keystrokes directly into the active OS window.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to type." }
        },
        required: ["text"]
      }
    }
  }
];

// Tools exposed to the model. search_web is only included when a search
// provider endpoint is configured; otherwise the model is expected to use
// the embedded browser tools (browser_navigate + browser_get_dom) to search.
export const getSystemTools = () =>
  isWebSearchConfigured() ? SYSTEM_TOOLS : SYSTEM_TOOLS.filter(t => t.function.name !== 'search_web');
