export const REDACTED_VALUE = '[redacted]';
export const SENSITIVE_CONTROL_PATTERN_SOURCE = [
  'password', 'hidden', 'secret', 'token', 'api.?key', 'authorization', 'credential',
  'csrf', 'xsrf', 'session', 'cookie', 'bearer', 'otp', 'one[-_ ]?time', '(?:^|[-_ ])pin(?:$|[-_ ])',
  'credit[-_ ]?card', '(?:^|[-_ ])cc[-_ ]', 'cvc', 'cvv',
].join('|');
const MAX_WARNING_SCAN_CHARS = 1_000_000;
const MAX_WARNING_SCAN_ENTRIES = 50_000;
const MAX_WARNING_SCAN_DEPTH = 64;

interface PendingSafetyValue {
  value: unknown;
  depth: number;
  key?: string;
}

function safetyText(value: unknown): string {
  const parts: string[] = [];
  const seen = new WeakSet<object>();
  let remaining = MAX_WARNING_SCAN_CHARS;
  let remainingEntries = MAX_WARNING_SCAN_ENTRIES;
  const append = (text: string): void => {
    if (remaining <= 0) return;
    const chunk = text.slice(0, remaining);
    parts.push(chunk);
    remaining -= chunk.length;
  };
  const pending: PendingSafetyValue[] = [{ value, depth: 0 }];
  while (pending.length > 0 && remaining > 0 && remainingEntries > 0) {
    const current = pending.pop()!;
    remainingEntries -= 1;
    if (current.key) append(current.key);
    const entry = current.value;
    if (entry === null || entry === undefined || current.depth > MAX_WARNING_SCAN_DEPTH) continue;
    if (typeof entry === 'string') { append(entry); continue; }
    if (typeof entry !== 'object') { append(String(entry)); continue; }
    if (seen.has(entry)) continue;
    seen.add(entry);
    const capacity = Math.max(0, remainingEntries - pending.length);
    if (capacity === 0) continue;
    if (Array.isArray(entry)) {
      const count = Math.min(entry.length, capacity);
      for (let index = count - 1; index >= 0; index -= 1) {
        let item: unknown;
        try { item = entry[index]; } catch { continue; }
        pending.push({ value: item, depth: current.depth + 1 });
      }
      continue;
    }
    const children: PendingSafetyValue[] = [];
    try {
      for (const key in entry) {
        if (children.length >= capacity) break;
        if (!Object.hasOwn(entry, key)) continue;
        let item: unknown;
        try { item = (entry as Record<string, unknown>)[key]; } catch { continue; }
        children.push({ value: item, depth: current.depth + 1, key });
      }
    } catch {
      continue;
    }
    for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]!);
  }
  return parts.join('\n');
}

export function detectInjectionWarnings(value: unknown): string[] {
  const content = safetyText(value);
  const warnings: string[] = [];
  if (/ignore (all |any )?(previous|prior) instructions/i.test(content)) {
    warnings.push('Page content contains instruction-override language.');
  }
  if (/(system prompt|developer message|tool call|exfiltrat|send (the )?(cookie|token|secret))/i.test(content)) {
    warnings.push('Page content contains terms associated with prompt injection or data exfiltration.');
  }
  return warnings;
}

export function mergeInjectionWarnings(...values: unknown[]): string[] {
  return [...new Set(values.flatMap((value) => detectInjectionWarnings(value)))];
}
