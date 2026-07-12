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
    const end = findWordBoundaryEnd(normalized, Math.min(start + size, normalized.length));
    chunks.push(normalized.slice(start, end).trim());
    if (end === normalized.length) {
      break;
    }
    start = findWordBoundaryStart(normalized, Math.max(end - overlap, start + 1));
  }

  return chunks;
}

function findWordBoundaryEnd(text: string, targetEnd: number): number {
  if (targetEnd >= text.length) {
    return text.length;
  }
  if (!isInsideWord(text, targetEnd)) {
    return targetEnd;
  }

  let end = targetEnd;
  while (end < text.length && isWordCharacter(text[end])) {
    end += 1;
  }
  return end;
}

function findWordBoundaryStart(text: string, targetStart: number): number {
  if (targetStart <= 0) {
    return 0;
  }
  if (targetStart >= text.length) {
    return text.length;
  }
  if (!isInsideWord(text, targetStart)) {
    return targetStart;
  }

  let start = targetStart;
  while (start < text.length && isWordCharacter(text[start])) {
    start += 1;
  }
  while (start < text.length && /\s/u.test(text[start])) {
    start += 1;
  }
  return start;
}

function isInsideWord(text: string, index: number): boolean {
  return isWordCharacter(text[index - 1]) && isWordCharacter(text[index]);
}

function isWordCharacter(character: string | undefined): boolean {
  return Boolean(character && /[\p{L}\p{N}]/u.test(character));
}

export function mergeOverlappingChunks(chunks: string[], minOverlap = 20, maxOverlap = 250): string {
  return chunks.reduce((merged, chunk) => {
    const current = chunk.trim();
    if (!current) {
      return merged;
    }
    if (!merged) {
      return current;
    }

    const overlap = findOverlapLength(merged, current, minOverlap, maxOverlap);
    return `${merged}${current.slice(overlap)}`;
  }, '');
}

function findOverlapLength(previous: string, current: string, minOverlap: number, maxOverlap: number): number {
  const maxLength = Math.min(previous.length, current.length, maxOverlap);
  const normalizedPrevious = previous.toLowerCase();
  const normalizedCurrent = current.toLowerCase();

  for (let length = maxLength; length >= minOverlap; length -= 1) {
    if (normalizedPrevious.endsWith(normalizedCurrent.slice(0, length))) {
      return length;
    }
  }

  return 0;
}

export function buildExcerpt(text: string, terms: string[], length = 160): string {
  const lower = text.toLowerCase();
  const firstMatch = terms
    .map((term) => lower.indexOf(term.toLowerCase()))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];

  const start = Math.max((firstMatch ?? 0) - 80, 0);
  const excerpt = text.slice(start, start + length).trim();
  return `${start > 0 ? '...' : ''}${excerpt}${start + length < text.length ? '...' : ''}`;
}

export function buildMultiTermExcerpt(texts: string[], terms: string[], length = 160): string {
  const uniqueTerms = Array.from(new Set(terms.filter(Boolean)));
  if (uniqueTerms.length <= 1) {
    return buildExcerpt(texts[0] ?? '', uniqueTerms, length);
  }

  const availableTerms = uniqueTerms.filter((term) => texts.some((text) => text.toLowerCase().includes(term.toLowerCase())));
  if (availableTerms.length === 0) {
    return buildExcerpt(texts[0] ?? '', uniqueTerms, length);
  }

  const separator = ' ... ';
  const snippetLength = Math.max(24, Math.floor((length - separator.length * (availableTerms.length - 1)) / availableTerms.length));
  const snippets = availableTerms.map((term) => buildTermSnippet(texts, term, snippetLength));
  const excerpt = Array.from(new Set(snippets)).join(separator);
  return excerpt.length <= length ? excerpt : excerpt.slice(0, length).trim();
}

function buildTermSnippet(texts: string[], term: string, length: number): string {
  const lowerTerm = term.toLowerCase();
  const text = texts.find((candidate) => candidate.toLowerCase().includes(lowerTerm)) ?? texts[0] ?? '';
  const lowerText = text.toLowerCase();
  const matchIndex = Math.max(lowerText.indexOf(lowerTerm), 0);
  const termEnd = matchIndex + term.length;
  const start = Math.max(Math.min(matchIndex - 8, text.length - length), 0);
  const end = Math.min(Math.max(start + length, termEnd + 8), text.length);
  const snippet = text.slice(start, end).trim();
  return `${start > 0 ? '...' : ''}${snippet}${end < text.length ? '...' : ''}`;
}
