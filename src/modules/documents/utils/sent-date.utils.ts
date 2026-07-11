const monthIndexesByLanguage: Record<string, Record<string, number>> = {
  deu: buildMonthMap([
    ['januar', 'jan'],
    ['februar', 'feb'],
    ['marz', 'maerz', 'märz', 'mrz', 'mär'],
    ['april', 'apr'],
    ['mai'],
    ['juni', 'jun'],
    ['juli', 'jul'],
    ['august', 'aug'],
    ['september', 'sep', 'sept'],
    ['oktober', 'okt'],
    ['november', 'nov'],
    ['dezember', 'dez'],
  ]),
  eng: buildMonthMap([
    ['january', 'jan'],
    ['february', 'feb'],
    ['march', 'mar'],
    ['april', 'apr'],
    ['may'],
    ['june', 'jun'],
    ['july', 'jul'],
    ['august', 'aug'],
    ['september', 'sep', 'sept'],
    ['october', 'oct'],
    ['november', 'nov'],
    ['december', 'dec'],
  ]),
  fra: buildMonthMap([
    ['janvier', 'janv', 'jan'],
    ['fevrier', 'février', 'fevr', 'févr', 'fev', 'fév'],
    ['mars', 'mar'],
    ['avril', 'avr'],
    ['mai'],
    ['juin', 'jun'],
    ['juillet', 'juil', 'jul'],
    ['aout', 'août'],
    ['septembre', 'sept', 'sep'],
    ['octobre', 'oct'],
    ['novembre', 'nov'],
    ['decembre', 'décembre', 'dec', 'déc'],
  ]),
};

const numericDatePattern = /\b([0-3]?\d)\.([01]?\d)\.(\d{4})\b/g;
const namedDatePattern = /\b([0-3]?\d)\.\s*([A-Za-zÀ-ÖØ-öø-ÿ]{3,})\.?\s+(\d{4})\b/g;

export function detectSentDate(text: string, language: string): Date | undefined {
  const relevantText = firstQuarter(text);
  const numericMatch = firstValidNumericDate(relevantText);
  if (numericMatch) {
    return numericMatch;
  }

  const monthIndexes = monthIndexesByLanguage[language] ?? combinedMonthIndexes();
  for (const match of relevantText.matchAll(namedDatePattern)) {
    const day = Number(match[1]);
    const month = monthIndexes[normalizeMonthName(match[2])];
    const year = Number(match[3]);
    const date = month === undefined ? undefined : buildValidUtcDate(year, month, day);
    if (date) {
      return date;
    }
  }

  return undefined;
}

function firstQuarter(text: string) {
  return text.slice(0, Math.ceil(text.length * 0.25));
}

export function parseSentDateInput(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return undefined;
  }
  return buildValidUtcDate(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function formatSentDate(date?: Date): string | undefined {
  return date?.toISOString().slice(0, 10);
}

function firstValidNumericDate(text: string) {
  for (const match of text.matchAll(numericDatePattern)) {
    const date = buildValidUtcDate(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
    if (date) {
      return date;
    }
  }
  return undefined;
}

function buildValidUtcDate(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) {
    return undefined;
  }
  return date;
}

function buildMonthMap(monthNames: string[][]) {
  return monthNames.reduce<Record<string, number>>((acc, names, monthIndex) => {
    for (const name of names) {
      acc[normalizeMonthName(name)] = monthIndex;
    }
    return acc;
  }, {});
}

function combinedMonthIndexes() {
  return Object.values(monthIndexesByLanguage).reduce<Record<string, number>>((acc, monthIndexes) => ({ ...acc, ...monthIndexes }), {});
}

function normalizeMonthName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
}
