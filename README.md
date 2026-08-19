# Standalone AI Browser Agent

Welcome to the Standalone AI Browser Agent project! This is a cross-platform (MacOS, Windows, Linux) desktop application built with Electron. It functions as an autonomous AI agent equipped with a deeply integrated, embedded web browser.

## What it Does

This application serves as an "Agentic Browser". Instead of you browsing the web, you interact with an AI agent via a chat interface, and the agent uses the embedded Chromium browser to complete tasks on your behalf. 

Because the browser is built directly into the app using Electron, the agent has native, low-level access to the web page, bypassing the common limitations of standard browser extensions or external automation frameworks.

## Key Capabilities

- **Native Embedded Browser**: Features a built-in Chromium viewport via Electron's `BrowserView`/`WebContents`.
- **Perfect Natural Inputs**: Controls the browser natively using Electron's `webContents.debugger`. It performs human-like mouse movements, clicks, holds, releases, double-clicks, and full keyboard actions (typing, shortcuts, keyholds) completely undetected by bot-mitigation systems.
- **Advanced Vision & Inspection**: 
  - Extracts full DOM and Accessibility Trees for semantic understanding.
  - Injects "Set-of-Mark" bounding boxes directly onto the page to capture screenshots that the LLM can perfectly understand and interact with.
- **Profile Importing**: Seamlessly imports existing user profiles (Cookies, LocalStorage, Preferences) from your local installations of Google Chrome and Mozilla Firefox. It handles the complex cross-platform OS-level decryption (DPAPI, Keychain, NSS) so you stay logged into your favorite sites.
- **Multi-Model LLM Engine**: Bring your own AI model. The app supports any OpenAI-compatible API endpoint, allowing you to use:
  - Local Models: Ollama, LM Studio, vLLM
  - Cloud Models: OpenRouter, OpenAI, Anthropic, etc.

## Architecture

The project is structured into several core modules:
- **`src/main/agent/`**: The brain of the operation. This module handles the autonomous loop (Plan, Observe, Act), translating your prompts into browser interactions.
- **`src/main/browser/`**: The Electron CDP integration layer. Handles vision, mouse inputs, keyboard inputs, and DOM extraction.
- **`src/main/importer/`**: The Chrome/Firefox SQLite decryption and cookie ingestion engine.
- **`src/renderer/`**: The frontend UI built with TypeScript, React, and TailwindCSS (or Vanilla). It contains the chat interface, the embedded browser viewport, and the configuration settings for LLM API keys and endpoints.

## Development Constraints & Rules

- **Language**: TypeScript is strictly used throughout the codebase.
- **Styling**: Variable names must always be written in `camelCase`.
- **Dependencies**: The app uses Electron's native Chrome DevTools Protocol (CDP) for browser control, completely removing the need for heavy external dependencies like Playwright or Selenium.
