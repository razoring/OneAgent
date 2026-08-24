// Universal document and reasoning parser for OneAgent

// Strips null bytes and non-printable control characters, normalizes whitespace
export function sanitizeText(text: string, maxChars: number = 150000): string {
  if (!text) return '';
  
  // Remove non-printable control characters except \t, \n, \r
  let cleaned = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  
  // Normalize Windows CRLF to LF
  cleaned = cleaned.replace(/\r\n/g, '\n');
  
  // Collapse 4+ consecutive newlines to 2
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  if (cleaned.length > maxChars) {
    const total = cleaned.length;
    cleaned = cleaned.slice(0, maxChars) + `\n\n[... Document truncated: Showing first ${maxChars.toLocaleString()} of ${total.toLocaleString()} characters to fit model context ...]`;
  }

  return cleaned.trim();
}

// Cleans HTML by stripping scripts, styles, embedded SVGs, comments, and converting to markdown text
export function cleanHtml(html: string): string {
  if (!html) return '';
  
  const text = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, '\n\n# $1\n\n')
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n\n$1\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n* $1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

  return sanitizeText(
    text
      .split('\n')
      .map(line => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n\n')
  );
}

// Parses MHTML multipart files by extracting the primary text/html body and discarding embedded assets
export function parseMhtml(mhtml: string): string {
  if (!mhtml) return '';
  
  const boundaryMatch = mhtml.match(/boundary="?([^"\r\n]+)"?/i);
  if (!boundaryMatch) {
    return cleanHtml(mhtml);
  }
  const boundary = boundaryMatch[1];
  const parts = mhtml.split(new RegExp(`--${boundary}(?:--)?`, 'g'));
  
  for (const part of parts) {
    if (/Content-Type:\s*text\/html/i.test(part) || /Content-Type:\s*text\/plain/i.test(part)) {
      const isQuotedPrintable = /Content-Transfer-Encoding:\s*quoted-printable/i.test(part);
      const isBase64 = /Content-Transfer-Encoding:\s*base64/i.test(part);
      const isPlain = /Content-Type:\s*text\/plain/i.test(part);
      
      const bodyIndex = part.indexOf('\n\n') !== -1 ? part.indexOf('\n\n') : part.indexOf('\r\n\r\n');
      let body = bodyIndex !== -1 ? part.slice(bodyIndex) : part;
      
      if (isQuotedPrintable) {
        body = body
          .replace(/=\r?\n/g, '')
          .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      } else if (isBase64) {
        try {
          const cleanB64 = body.replace(/\s+/g, '');
          if (typeof atob === 'function') {
            body = decodeURIComponent(escape(atob(cleanB64)));
          } else if (typeof (globalThis as any).Buffer !== 'undefined') {
            body = (globalThis as any).Buffer.from(cleanB64, 'base64').toString('utf-8');
          }
        } catch {
          // ignore base64 decode errors
        }
      }
      
      return isPlain ? sanitizeText(body) : cleanHtml(body);
    }
  }
  return cleanHtml(mhtml);
}

// Extracts <think>...</think> reasoning blocks from text
export interface ParsedThinkingResult {
  thinking: string;
  content: string;
  isThinking: boolean;
  toolCalls: string[];
  isCallingTool: boolean;
}

export function extractThinkingAndContent(raw: string): ParsedThinkingResult {
  if (!raw) return { thinking: '', content: '', isThinking: false, toolCalls: [], isCallingTool: false };

  let thinking = '';
  let content = raw;
  let isThinking = false;

  // 1. Extract ALL thinking blocks. Models occasionally emit more than one
  //    (e.g. re-open <think> after answering); any block left unextracted
  //    would leak raw reasoning into the visible response.
  while (true) {
    const thinkOpenIndex = content.indexOf('<think>');
    if (thinkOpenIndex === -1) break;
    const thinkCloseIndex = content.indexOf('</think>', thinkOpenIndex);
    if (thinkCloseIndex === -1) {
      // Unclosed block: everything up to <think> is content, the rest is thinking.
      thinking = [thinking, content.slice(thinkOpenIndex + 7).trim()].filter(Boolean).join('\n\n');
      content = content.slice(0, thinkOpenIndex).trim();
      isThinking = true;
      break;
    }
    thinking = [thinking, content.slice(thinkOpenIndex + 7, thinkCloseIndex).trim()].filter(Boolean).join('\n\n');
    content = (content.slice(0, thinkOpenIndex) + '\n\n' + content.slice(thinkCloseIndex + 8)).trim();
  }

  // 1b. Strip <reasoning_digest> echoes. Digest blocks are OUR context-injection
  //     format; models sometimes parrot them from history into their answer.
  while (true) {
    const digestOpen = content.indexOf('<reasoning_digest>');
    if (digestOpen === -1) break;
    const digestClose = content.indexOf('</reasoning_digest>', digestOpen);
    if (digestClose === -1) {
      // Unterminated digest: everything after the opener is scaffolding.
      content = content.slice(0, digestOpen).trim();
      break;
    }
    content = (content.slice(0, digestOpen) + '\n' + content.slice(digestClose + 19)).trim();
  }

  // 2. Extract Tool Calls
  const toolCalls: string[] = [];
  let isCallingTool = false;
  
  while (true) {
    const toolOpenIndex = content.indexOf('<tool_call>');
    if (toolOpenIndex === -1) break;
    
    const toolCloseIndex = content.indexOf('</tool_call>', toolOpenIndex);
    if (toolCloseIndex === -1) {
      // Incomplete tool call at the end of the stream
      isCallingTool = true;
      const rawCall = content.slice(toolOpenIndex + 11).trim();
      if (rawCall) toolCalls.push(rawCall);
      content = content.slice(0, toolOpenIndex).trim();
      break;
    }
    
    // Complete tool call
    const callStr = content.slice(toolOpenIndex + 11, toolCloseIndex).trim();
    if (callStr) toolCalls.push(callStr);
    
    const beforeTool = content.slice(0, toolOpenIndex).trim();
    const afterTool = content.slice(toolCloseIndex + 12).trim();
    content = [beforeTool, afterTool].filter(Boolean).join('\n\n');
  }

  return { thinking, content, isThinking, toolCalls, isCallingTool };
}
