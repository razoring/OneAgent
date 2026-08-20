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
}

export function extractThinkingAndContent(raw: string): ParsedThinkingResult {
  if (!raw) return { thinking: '', content: '', isThinking: false };

  const thinkOpenIndex = raw.indexOf('<think>');
  if (thinkOpenIndex === -1) {
    return { thinking: '', content: raw, isThinking: false };
  }

  const thinkCloseIndex = raw.indexOf('</think>');
  if (thinkCloseIndex === -1) {
    // Currently still thinking (streaming inside <think>)
    const thinking = raw.slice(thinkOpenIndex + 7).trim();
    const content = raw.slice(0, thinkOpenIndex).trim();
    return { thinking, content, isThinking: true };
  }

  // Completed think block
  const thinking = raw.slice(thinkOpenIndex + 7, thinkCloseIndex).trim();
  const beforeThink = raw.slice(0, thinkOpenIndex).trim();
  const afterThink = raw.slice(thinkCloseIndex + 8).trim();
  const content = [beforeThink, afterThink].filter(Boolean).join('\n\n');

  return { thinking, content, isThinking: false };
}
