export function normalizeTerms(input: string): string[] {
  return Array.from(
    new Set(
      input
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .map((term) => term.trim())
        .filter((term) => term.length > 1),
    ),
  );
}

export function buildPartialTerms(input: string, minLength = 3, maxLength = 24): string[] {
  return Array.from(
    new Set(
      normalizeTerms(input).flatMap((term) => {
        const cappedLength = Math.min(term.length, maxLength);
        const partials: string[] = [];
        for (let length = minLength; length <= cappedLength; length += 1) {
          partials.push(term.slice(0, length));
        }
        return partials;
      }),
    ),
  );
}

export function chunkText(text: string, size = 1000, overlap = 150): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return [];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < normalized.length) {
    const end = Math.min(start + size, normalized.length);
    chunks.push(normalized.slice(start, end).trim());
    if (end === normalized.length) {
      break;
    }
    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
}

export function buildExcerpt(text: string, terms: string[], length = 260): string {
  const lower = text.toLowerCase();
  const firstMatch = terms
    .map((term) => lower.indexOf(term.toLowerCase()))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];

  const start = Math.max((firstMatch ?? 0) - 80, 0);
  const excerpt = text.slice(start, start + length).trim();
  return `${start > 0 ? '...' : ''}${excerpt}${start + length < text.length ? '...' : ''}`;
}
