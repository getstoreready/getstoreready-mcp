export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export function text(value: unknown) {
  const str = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text' as const, text: str }] };
}

export function mixed(content: McpContent[]) {
  return { content };
}
