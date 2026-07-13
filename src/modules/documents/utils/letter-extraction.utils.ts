import { detectSentDate } from './sent-date.utils';

export interface LetterFields {
  sender?: string;
  recipient?: string;
  sentAt?: Date;
  subject?: string;
  referenceNumber?: string;
  invoiceNumber?: string;
  customerNumber?: string;
  accountNumber?: string;
  deadlineAt?: Date;
  paymentDueAt?: Date;
}

export type LetterFieldName = keyof LetterFields;

export interface LetterFieldSource {
  method: 'layout' | 'label' | 'pattern' | 'fallback';
  location: string;
  detail?: string;
}

export interface LetterExtractionResult {
  fields: LetterFields;
  sources: Partial<Record<LetterFieldName, LetterFieldSource>>;
}

export interface LetterLayoutLine {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface LetterLayoutPage {
  lines: LetterLayoutLine[];
}

const senderLabel = /^(?:absender|sender|from|expediteur|expéditeur)\s*:?\s*(.*)$/iu;
const recipientLabel = /^(?:empfanger|empfänger|recipient|to|destinataire)\s*:?\s*(.*)$/iu;
const subjectLabel = /^(?:betreff|subject|objet)\s*:?\s*(.*)$/iu;

const referencePatterns = [
  /\b(REF(?:[-_/][A-Z0-9][A-Z0-9./_-]{2,}|\d[A-Z0-9./_-]{2,}))\b/iu,
  /\b(?:referenz|ref(?:erence)?|zeichen|dossier)\s*(?:nr\.?|number|no\.?|#)?\s*[:.-]?\s*([A-Z0-9][A-Z0-9./_-]{2,})\b/iu,
];
const invoicePatterns = [
  /\b(?:rechnung|invoice|facture)\s*(?:nr\.?|number|no\.?|#)?\s*[:.-]?\s*([A-Z0-9][A-Z0-9./_-]{2,})\b/iu,
];
const customerPatterns = [
  /\b(?:kundennr\.?|kunde\s*(?:nr\.?|nummer|#)|customer\s*(?:nr\.?|number|no\.?|#)|client\s*(?:nr\.?|number|no\.?|#))\s*[:.-]?\s*([A-Z0-9][A-Z0-9./_-]{2,})\b/iu,
];
const accountPatterns = [
  /\b(?:kontonr\.?|konto\s*(?:nr\.?|nummer|#)|account\s*(?:nr\.?|number|no\.?|#)|compte\s*(?:nr\.?|number|no\.?|#))\s*[:.-]?\s*([A-Z0-9][A-Z0-9./_-]{2,})\b/iu,
  /\b(?:iban)\s*[:.-]?\s*([A-Z]{2}\d{2}[A-Z0-9 ]{8,})\b/iu,
];
const deadlineLabels = /\b(?:frist|deadline|response due|reply by|antwort bis|reponse avant|réponse avant)\b/iu;
const paymentDueLabels = /\b(?:zahlbar bis|zahlung bis|fällig|faellig|due date|payment due|echeance|échéance)\b/iu;
const receiverAnchorTerms = ['hänggi', 'hanggi', 'haenggi', 'gablerackerstrasse', '8615', 'wermatswil'];

export function extractLetterFields(text: string, language: string, layoutPages: LetterLayoutPage[] = []): LetterFields {
  return extractLetterMetadata(text, language, layoutPages).fields;
}

export function extractLetterMetadata(text: string, language: string, layoutPages: LetterLayoutPage[] = []): LetterExtractionResult {
  const lines = meaningfulLines(text);
  const topLines = lines.slice(0, 40);
  const layout = extractLayoutLetterFields(layoutPages[0], language);
  const sender =
    detectedValue('sender', layout) ??
    detectLabeledBlock(topLines, senderLabel, 'sender') ??
    detectTopSenderFallback(topLines);
  const recipient = detectedValue('recipient', layout) ?? detectLabeledBlock(topLines, recipientLabel, 'recipient');
  const sentAt =
    detectedValue('sentAt', layout) ??
    detectLetterDate(topLines, language) ??
    detectWholeTextDate(text, language);
  const subject = detectedValue('subject', layout) ?? detectLabeledValue(topLines, subjectLabel, 'subject');
  const referenceNumber = detectFirstPattern(text, referencePatterns, 'referenceNumber');
  const invoiceNumber = detectFirstPattern(text, invoicePatterns, 'invoiceNumber');
  const customerNumber = detectFirstPattern(text, customerPatterns, 'customerNumber');
  const accountNumber = normalizeDetectedIdentifier(detectFirstPattern(text, accountPatterns, 'accountNumber'));
  const deadlineAt = detectLabeledDate(lines, deadlineLabels, language, 'deadlineAt');
  const paymentDueAt = detectLabeledDate(lines, paymentDueLabels, language, 'paymentDueAt');

  const detections = [sender, recipient, sentAt, subject, referenceNumber, invoiceNumber, customerNumber, accountNumber, deadlineAt, paymentDueAt];
  return {
    fields: removeEmptyFields(Object.fromEntries(detections.filter(Boolean).map((detection) => [detection!.field, detection!.value])) as LetterFields),
    sources: Object.fromEntries(detections.filter(Boolean).map((detection) => [detection!.field, detection!.source])),
  };
}

export function letterFieldsSearchText(fields: LetterFields): string {
  return [
    fields.sender,
    fields.recipient,
    fields.subject,
    fields.referenceNumber,
    fields.invoiceNumber,
    fields.customerNumber,
    fields.accountNumber,
  ]
    .filter(Boolean)
    .join(' ');
}

function meaningfulLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length >= 2);
}

interface DetectedLetterField<T extends string | Date = string | Date> {
  field: LetterFieldName;
  value: T;
  source: LetterFieldSource;
}

function detectedValue(field: LetterFieldName, result: LetterExtractionResult): DetectedLetterField | undefined {
  const value = result.fields[field];
  const source = result.sources[field];
  return value && source ? { field, value, source } : undefined;
}

function detectLabeledValue(lines: string[], label: RegExp, field: LetterFieldName): DetectedLetterField<string> | undefined {
  for (const [index, line] of lines.entries()) {
    const match = label.exec(line);
    const value = cleanValue(match?.[1]);
    if (value) {
      return {
        field,
        value,
        source: {
          method: 'label',
          location: `text line ${index + 1}`,
          detail: `Matched label in "${truncateSourceLine(line)}"`,
        },
      };
    }
  }
  return undefined;
}

function detectLabeledBlock(lines: string[], label: RegExp, field: LetterFieldName): DetectedLetterField<string> | undefined {
  const index = lines.findIndex((line) => label.test(line));
  if (index === -1) {
    return undefined;
  }

  const firstLineValue = cleanValue(label.exec(lines[index])?.[1]);
  const block = firstLineValue ? [firstLineValue] : [];
  for (const line of lines.slice(index + 1, index + 5)) {
    if (isLikelyNewSection(line)) {
      break;
    }
    block.push(line);
  }
  const value = cleanFieldValue(joinFieldLines(block, field), field);
  return value
    ? {
        field,
        value,
        source: {
          method: 'label',
          location: `text lines ${index + 1}-${index + block.length}`,
          detail: `Matched block label in "${truncateSourceLine(lines[index])}"`,
        },
      }
    : undefined;
}

function detectTopSenderFallback(lines: string[]): DetectedLetterField<string> | undefined {
  const block: string[] = [];
  let startLine = 0;
  for (const [index, line] of lines.slice(0, 12).entries()) {
    if (isLikelyNewSection(line)) {
      if (block.length > 0) {
        break;
      }
      continue;
    }
    if ((/[\p{L}]{3,}/u.test(line) || isSenderContactLine(line)) && !/\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/u.test(line)) {
      if (block.length === 0) {
        startLine = index + 1;
      }
      block.push(line);
    }
    if (block.length >= 6) {
      break;
    }
  }
  const value = block.length > 0 ? cleanFieldValue(joinFieldLines(block, 'sender'), 'sender') : undefined;
  return value
    ? {
        field: 'sender',
        value,
        source: {
          method: 'fallback',
          location: `top text lines ${startLine}-${startLine + block.length - 1}`,
          detail: 'No sender label/layout value; used first plausible top-of-letter lines',
        },
      }
    : undefined;
}

function detectFirstPattern(text: string, patterns: RegExp[], field: LetterFieldName): DetectedLetterField<string> | undefined {
  for (const [index, pattern] of patterns.entries()) {
    const match = pattern.exec(text);
    const value = cleanValue(match?.[1]);
    if (value) {
      return {
        field,
        value,
        source: {
          method: 'pattern',
          location: `full text pattern ${index + 1}`,
          detail: `Matched near "${truncateSourceLine(match?.[0] ?? value)}"`,
        },
      };
    }
  }
  return undefined;
}

function detectLabeledDate(lines: string[], label: RegExp, language: string, field: LetterFieldName): DetectedLetterField<Date> | undefined {
  for (const [index, line] of lines.entries()) {
    if (!label.test(line)) {
      continue;
    }
    const date = parseNumericDate(line) ?? detectSentDate(line, language);
    if (date) {
      return {
        field,
        value: date,
        source: {
          method: 'label',
          location: `text line ${index + 1}`,
          detail: `Matched date label in "${truncateSourceLine(line)}"`,
        },
      };
    }
  }
  return undefined;
}

function detectLetterDate(lines: string[], language: string): DetectedLetterField<Date> | undefined {
  for (const [index, line] of lines.entries()) {
    if (deadlineLabels.test(line) || paymentDueLabels.test(line)) {
      continue;
    }
    const date = parseNumericDate(line) ?? detectSentDate(line, language);
    if (date) {
      return {
        field: 'sentAt',
        value: date,
        source: {
          method: 'pattern',
          location: `top text line ${index + 1}`,
          detail: `Matched top-of-letter date in "${truncateSourceLine(line)}"`,
        },
      };
    }
  }
  return undefined;
}

function detectWholeTextDate(text: string, language: string): DetectedLetterField<Date> | undefined {
  const value = detectSentDate(text, language);
  return value
    ? {
        field: 'sentAt',
        value,
        source: {
          method: 'fallback',
          location: 'full text date detector',
          detail: 'Detected date from first quarter or last tenth of document text',
        },
      }
    : undefined;
}

function normalizeDetectedIdentifier(detection: DetectedLetterField<string> | undefined): DetectedLetterField<string> | undefined {
  if (!detection) {
    return undefined;
  }
  return { ...detection, value: normalizeIdentifier(detection.value) ?? detection.value };
}

function extractLayoutLetterFields(page: LetterLayoutPage | undefined, language: string): LetterExtractionResult {
  const lines = normalizedLayoutLines(page);
  if (lines.length === 0) {
    return { fields: {}, sources: {} };
  }

  const width = Math.max(...lines.map((line) => line.x1));
  const height = Math.max(...lines.map((line) => line.y1));
  const topLines = lines.filter((line) => line.y0 <= height * 0.95);
  const topLeftLines = topLines.filter((line) => line.x0 <= width * 0.55);
  const topRightLines = topLines.filter((line) => line.x0 >= width * 0.45);
  const subjectLine = topLines.find((line) => subjectLabel.test(line.text));
  const subjectY = subjectLine?.y0;
  const anchoredRecipientLines = findReceiverAnchorBlock(topLines, height);
  const sender = extractLayoutSender(topLeftLines, height, anchoredRecipientLines);
  const recipient = extractLayoutRecipient(topLeftLines, height, subjectY ?? height * 0.9, anchoredRecipientLines);
  const sentAt = extractLayoutDate(topRightLines, language) ?? extractLayoutDate(topLines, language);
  const subject = subjectLine ? cleanValue(subjectLabel.exec(subjectLine.text)?.[1]) : extractLayoutSubject(topLines, recipient?.value, subjectY);

  const detections: Array<DetectedLetterField | undefined> = [
    sender,
    recipient,
    sentAt,
    subject
      ? {
          field: 'subject',
          value: subject,
          source: {
            method: 'layout',
            location: subjectLine ? `page 1 subject label zone ${bboxLocation(subjectLine)}` : 'page 1 subject zone',
            detail: subjectLine ? `Matched subject label in "${truncateSourceLine(subjectLine.text)}"` : 'Selected text near/after recipient block',
          },
        }
      : undefined,
  ];
  return {
    fields: removeEmptyFields(Object.fromEntries(detections.filter(Boolean).map((detection) => [detection!.field, detection!.value])) as LetterFields),
    sources: Object.fromEntries(detections.filter(Boolean).map((detection) => [detection!.field, detection!.source])),
  };
}

function normalizedLayoutLines(page: LetterLayoutPage | undefined): LetterLayoutLine[] {
  return (page?.lines ?? [])
    .map((line) => ({ ...line, text: line.text.replace(/\s+/g, ' ').trim() }))
    .filter((line) => line.text.length >= 2)
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
}

function extractLayoutSender(
  lines: LetterLayoutLine[],
  pageHeight: number,
  anchoredRecipientLines: LetterLayoutLine[],
): DetectedLetterField<string> | undefined {
  const recipientLineKeys = new Set(anchoredRecipientLines.map(layoutLineKey));
  const candidates = lines
    .filter((line) => line.y0 <= pageHeight * 0.45)
    .filter((line) => /[\p{L}]{3,}/u.test(line.text) || isSenderContactLine(line.text))
    .filter((line) => !parseNumericDate(line.text) && !isLikelyNewSection(line.text))
    .filter((line) => !isContactLine(line.text) || isSenderContactLine(line.text))
    .filter((line) => !recipientLineKeys.has(layoutLineKey(line)) && !hasReceiverAnchor(line.text));
  const selected = selectSenderLines(candidates);
  const value = cleanFieldValue(joinFieldLines(selected.map((line) => line.text), 'sender'), 'sender');
  return value
    ? {
        field: 'sender',
        value,
        source: {
          method: 'layout',
          location: `page 1 top-left/header zone ${linesLocation(selected)}`,
          detail: 'Selected plausible sender lines from first-page header area',
        },
      }
    : undefined;
}

function extractLayoutRecipient(
  lines: LetterLayoutLine[],
  pageHeight: number,
  subjectY: number,
  anchoredRecipientLines: LetterLayoutLine[],
): DetectedLetterField<string> | undefined {
  const candidates = anchoredRecipientLines.length > 0 ? anchoredRecipientLines : lines
    .filter((line) => line.y0 >= pageHeight * 0.25 && line.y0 < Math.min(subjectY, pageHeight * 0.85))
    .filter((line) => /[\p{L}]{2,}/u.test(line.text))
    .filter((line) => !isContactLine(line.text) && !isSenderContactLine(line.text) && !parseNumericDate(line.text) && !isLikelyNewSection(line.text));

  const addressBlock = anchoredRecipientLines.length > 0 ? anchoredRecipientLines : densestVerticalBlock(candidates, 6);
  const value = cleanFieldValue(joinFieldLines(addressBlock.map((line) => line.text), 'recipient'), 'recipient');
  return value
    ? {
        field: 'recipient',
        value,
        source: {
          method: 'layout',
          location: `page 1 left address zone ${linesLocation(addressBlock)}`,
          detail:
            anchoredRecipientLines.length > 0
              ? `Selected recipient block because it contains known receiver anchor text: ${receiverAnchorTerms.join(', ')}`
              : 'Selected densest recipient/address block before subject area',
        },
      }
    : undefined;
}

function extractLayoutDate(lines: LetterLayoutLine[], language: string): DetectedLetterField<Date> | undefined {
  for (const line of lines) {
    if (deadlineLabels.test(line.text) || paymentDueLabels.test(line.text)) {
      continue;
    }
    const date = parseNumericDate(line.text) ?? detectSentDate(line.text, language);
    if (date) {
      return {
        field: 'sentAt',
        value: date,
        source: {
          method: 'layout',
          location: `page 1 date zone ${bboxLocation(line)}`,
          detail: `Matched date in "${truncateSourceLine(line.text)}"`,
        },
      };
    }
  }
  return undefined;
}

function extractLayoutSubject(lines: LetterLayoutLine[], recipient: string | undefined, subjectY: number | undefined): string | undefined {
  const recipientParts = new Set(recipient?.split(/\n|,/).map((part) => part.trim()) ?? []);
  const candidates = lines
    .filter((line) => (subjectY === undefined ? true : Math.abs(line.y0 - subjectY) <= 80))
    .filter((line) => line.text.length >= 6 && !parseNumericDate(line.text))
    .filter((line) => !senderLabel.test(line.text) && !recipientLabel.test(line.text) && !recipientParts.has(line.text));
  return cleanValue(candidates.at(-1)?.text);
}

function densestVerticalBlock(lines: LetterLayoutLine[], maxLines: number): LetterLayoutLine[] {
  if (lines.length <= maxLines) {
    return lines;
  }

  let best = lines.slice(0, maxLines);
  let bestSpan = best.at(-1)!.y1 - best[0].y0;
  for (let index = 1; index <= lines.length - maxLines; index += 1) {
    const candidate = lines.slice(index, index + maxLines);
    const span = candidate.at(-1)!.y1 - candidate[0].y0;
    if (span < bestSpan) {
      best = candidate;
      bestSpan = span;
    }
  }
  return best;
}

function findReceiverAnchorBlock(lines: LetterLayoutLine[], pageHeight: number): LetterLayoutLine[] {
  const anchorIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => hasReceiverAnchor(line.text))
    .map(({ index }) => index);
  if (anchorIndexes.length === 0) {
    return [];
  }

  const firstAnchor = anchorIndexes[0];
  const anchorLine = lines[firstAnchor];
  const x0 = anchorLine.x0 - 80;
  const x1 = anchorLine.x1 + 260;
  const y0 = Math.max(0, anchorLine.y0 - pageHeight * 0.06);
  const y1 = anchorLine.y1 + pageHeight * 0.18;

  return lines
    .filter((line) => line.x1 >= x0 && line.x0 <= x1 && line.y1 >= y0 && line.y0 <= y1)
    .filter((line) => !isContactLine(line.text) && !isSenderContactLine(line.text) && !parseNumericDate(line.text) && !isLikelyNewSection(line.text))
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
    .slice(0, 6);
}

function selectSenderLines(lines: LetterLayoutLine[]): LetterLayoutLine[] {
  const baseLines = lines.filter((line) => !isContactLine(line.text)).slice(0, 3);
  const contactLines = lines.filter((line) => isSenderContactLine(line.text)).slice(0, 3);
  return Array.from(new Map([...baseLines, ...contactLines].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0).map((line) => [`${line.x0}:${line.y0}:${line.text}`, line])).values());
}

function hasReceiverAnchor(text: string): boolean {
  const normalized = normalizeAnchorText(text);
  return receiverAnchorTerms.some((term) => normalized.includes(term));
}

function normalizeAnchorText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function layoutLineKey(line: LetterLayoutLine): string {
  return `${line.x0}:${line.y0}:${line.x1}:${line.y1}:${line.text}`;
}

function isContactLine(line: string): boolean {
  return /\b(?:tel|phone|fax|email|e-mail|www\.|http|@)\b/iu.test(line);
}

function isSenderContactLine(line: string): boolean {
  return (
    /\b(?:ansprechpartner|ansprechperson|kontakt|contact|responsible|sachbearbeiter|bearbeiter|berater|advisor)\b/iu.test(line) ||
    /\b(?:tel|telefon|phone|mobile|direct|fax|email|e-mail|mail)\b/iu.test(line) ||
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(line)
  );
}

function bboxLocation(line: LetterLayoutLine): string {
  return `bbox(${Math.round(line.x0)},${Math.round(line.y0)},${Math.round(line.x1)},${Math.round(line.y1)})`;
}

function linesLocation(lines: LetterLayoutLine[]): string {
  if (lines.length === 0) {
    return 'bbox(empty)';
  }
  const x0 = Math.min(...lines.map((line) => line.x0));
  const y0 = Math.min(...lines.map((line) => line.y0));
  const x1 = Math.max(...lines.map((line) => line.x1));
  const y1 = Math.max(...lines.map((line) => line.y1));
  return `bbox(${Math.round(x0)},${Math.round(y0)},${Math.round(x1)},${Math.round(y1)})`;
}

function isLikelyNewSection(line: string): boolean {
  return (
    senderLabel.test(line) ||
    recipientLabel.test(line) ||
    subjectLabel.test(line) ||
    referencePatterns.some((pattern) => pattern.test(line)) ||
    invoicePatterns.some((pattern) => pattern.test(line)) ||
    customerPatterns.some((pattern) => pattern.test(line)) ||
    accountPatterns.some((pattern) => pattern.test(line))
  );
}

function truncateSourceLine(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function joinFieldLines(lines: string[], field: LetterFieldName): string {
  return lines.join(field === 'sender' || field === 'recipient' ? '\n' : ', ');
}

function parseNumericDate(text: string): Date | undefined {
  const match = /\b([0-3]?\d)\.([01]?\d)\.(\d{4})\b/u.exec(text) ?? /\b(\d{4})-([01]\d)-([0-3]\d)\b/u.exec(text);
  if (!match) {
    return undefined;
  }
  const startsWithYear = match[1].length === 4;
  const year = Number(startsWithYear ? match[1] : match[3]);
  const month = Number(startsWithYear ? match[2] : match[2]) - 1;
  const day = Number(startsWithYear ? match[3] : match[1]);
  const date = new Date(Date.UTC(year, month, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day ? date : undefined;
}

function cleanValue(value?: string): string | undefined {
  const cleaned = value?.replace(/^[\s:;.,-]+|[\s:;.,-]+$/g, '').replace(/\s+/g, ' ').trim();
  return cleaned && cleaned.length >= 2 ? cleaned.slice(0, 240) : undefined;
}

function cleanFieldValue(value: string | undefined, field: LetterFieldName): string | undefined {
  if (field !== 'sender' && field !== 'recipient') {
    return cleanValue(value);
  }
  const cleaned = value
    ?.split('\n')
    .map((line) => line.replace(/^[\s:;.,-]+|[\s:;.,-]+$/g, '').replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return cleaned && cleaned.length >= 2 ? cleaned.slice(0, 240) : undefined;
}

function normalizeIdentifier(value?: string): string | undefined {
  return cleanValue(value?.replace(/\s+/g, ''));
}

function removeEmptyFields(fields: LetterFields): LetterFields {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== '')) as LetterFields;
}
