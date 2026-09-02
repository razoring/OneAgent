// AgentBrowser now re-uses the same encapsulated Browser core as the user-visible browser.
// Previously this was a <webview> with separate emulation logic — now it simply
// instantiates the shared Browser (WebContentsView) via BrowserChrome so both
// browsers have identical tabs, extensions, context menus and session.
import React from 'react';
import BrowserChrome from './BrowserChrome';
import { chatStore } from '../utils/chatStore';

const AgentBrowser: React.FC = () => {
  const chatId = chatStore.getActiveId() || 'default';
  // Each chat gets its own Browser instance (browserId = chatId) — same core as standalone
  // All instances share persist:oneagent_browser session (cookies) and extensions
  return <BrowserChrome agentId={chatId} />;
};

export default AgentBrowser;
