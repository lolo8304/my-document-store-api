import { extractLetterFields, letterFieldsSearchText } from './letter-extraction.utils';
import { formatSentDate } from './sent-date.utils';

describe('letter extraction utils', () => {
  it('extracts structured letter fields from labeled text', () => {
    const fields = extractLetterFields(
      [
        'Sender: Example Bank AG',
        'Main Street 1',
        '8000 Zurich',
        'Recipient: Jane Customer',
        'Customer Road 2',
        'Subject: Your account statement',
        'Reference No. REF-2026-7788',
        'Invoice No. INV-9001',
        'Customer No. CUST-42',
        'Account No. ACC-12345',
        'Zurich, 12.07.2026',
        'Payment due 31.07.2026',
        'Reply by 15.08.2026',
      ].join('\n'),
      'eng',
    );

    expect(fields.sender).toBe('Example Bank AG\nMain Street 1\n8000 Zurich');
    expect(fields.recipient).toBe('Jane Customer\nCustomer Road 2');
    expect(fields.subject).toBe('Your account statement');
    expect(fields.referenceNumber).toBe('REF-2026-7788');
    expect(fields.invoiceNumber).toBe('INV-9001');
    expect(fields.customerNumber).toBe('CUST-42');
    expect(fields.accountNumber).toBe('ACC-12345');
    expect(formatSentDate(fields.sentAt)).toBe('2026-07-12');
    expect(fields.sentLocation).toBe('Zurich');
    expect(formatSentDate(fields.paymentDueAt)).toBe('2026-07-31');
    expect(formatSentDate(fields.deadlineAt)).toBe('2026-08-15');
    expect(letterFieldsSearchText(fields)).toContain('REF-2026-7788');
  });

  it('detects sent location before a date with or without comma', () => {
    const withoutComma = extractLetterFields('Bern 16.04.2026', 'deu');
    const withMultiWordLocation = extractLetterFields('New York, 2026-04-16', 'eng');
    const withNamedMonth = extractLetterFields('Uster, 6. Juni 2026', 'deu');

    expect(formatSentDate(withoutComma.sentAt)).toBe('2026-04-16');
    expect(withoutComma.sentLocation).toBe('Bern');
    expect(formatSentDate(withMultiWordLocation.sentAt)).toBe('2026-04-16');
    expect(withMultiWordLocation.sentLocation).toBe('New York');
    expect(formatSentDate(withNamedMonth.sentAt)).toBe('2026-06-06');
    expect(withNamedMonth.sentLocation).toBe('Uster');
  });

  it('prefers first-page layout zones for sender, recipient, date, and subject', () => {
    const fields = extractLetterFields(
      [
        'REF-2026-7788',
        'Invoice No. INV-9001',
        'Payment due 31.07.2026',
      ].join('\n'),
      'eng',
      [
        {
          lines: [
            { text: 'Example Bank AG', x0: 80, y0: 70, x1: 280, y1: 90 },
            { text: 'Main Street 1', x0: 80, y0: 95, x1: 250, y1: 115 },
            { text: 'Contact: Max Muster', x0: 80, y0: 120, x1: 300, y1: 140 },
            { text: 'Tel. +41 44 123 45 67', x0: 80, y0: 145, x1: 310, y1: 165 },
            { text: 'max.muster@example-bank.ch', x0: 80, y0: 170, x1: 360, y1: 190 },
            { text: 'Zurich, 12.07.2026', x0: 640, y0: 120, x1: 820, y1: 140 },
            { text: 'Jane Customer', x0: 90, y0: 280, x1: 280, y1: 300 },
            { text: 'Customer Road 2', x0: 90, y0: 305, x1: 290, y1: 325 },
            { text: '8000 Zurich', x0: 90, y0: 330, x1: 230, y1: 350 },
            { text: 'Your account statement', x0: 90, y0: 430, x1: 360, y1: 455 },
          ],
        },
      ],
    );

    expect(fields.sender).toBe('Example Bank AG\nMain Street 1\nContact: Max Muster\nTel. +41 44 123 45 67\nmax.muster@example-bank.ch');
    expect(fields.recipient).toBe('Jane Customer\nCustomer Road 2\n8000 Zurich');
    expect(fields.subject).toBe('Your account statement');
    expect(formatSentDate(fields.sentAt)).toBe('2026-07-12');
    expect(fields.sentLocation).toBe('Zurich');
    expect(fields.referenceNumber).toBe('REF-2026-7788');
    expect(fields.invoiceNumber).toBe('INV-9001');
  });

  it('uses known receiver anchor text to disambiguate recipient from sender', () => {
    const fields = extractLetterFields(
      'Zurich, 12.07.2026',
      'eng',
      [
        {
          lines: [
            { text: 'Example Bank AG', x0: 80, y0: 70, x1: 280, y1: 90 },
            { text: 'Main Street 1', x0: 80, y0: 95, x1: 250, y1: 115 },
            { text: 'Doris Hänggi', x0: 90, y0: 145, x1: 210, y1: 165 },
            { text: 'Gablerackerstrasse 12', x0: 90, y0: 170, x1: 310, y1: 190 },
            { text: '8615 Wermatswil', x0: 90, y0: 195, x1: 270, y1: 215 },
            { text: 'Zurich, 12.07.2026', x0: 640, y0: 120, x1: 820, y1: 140 },
            { text: 'Your account statement', x0: 90, y0: 430, x1: 360, y1: 455 },
          ],
        },
      ],
    );

    expect(fields.sender).toBe('Example Bank AG\nMain Street 1');
    expect(fields.recipient).toBe('Doris Hänggi\nGablerackerstrasse 12\n8615 Wermatswil');
  });

  it.each(['Doris Hänggi', 'Yannick Hänggi', 'Silvan Hänggi'])('recognizes %s as receiver anchor text', (receiverName) => {
    const fields = extractLetterFields('', 'eng', [
      {
        lines: [
          { text: 'Example Bank AG', x0: 80, y0: 70, x1: 280, y1: 90 },
          { text: receiverName, x0: 90, y0: 145, x1: 260, y1: 165 },
          { text: 'Gablerackerstrasse 12', x0: 90, y0: 170, x1: 310, y1: 190 },
          { text: '8615 Wermatswil', x0: 90, y0: 195, x1: 270, y1: 215 },
        ],
      },
    ]);

    expect(fields.recipient).toBe(`${receiverName}\nGablerackerstrasse 12\n8615 Wermatswil`);
  });

  it('uses bottom footer line as sender when no header sender is available', () => {
    const fields = extractLetterFields('Bern, 16.04.2026', 'deu', [
      {
        lines: [
          { text: 'Bern, 16.04.2026', x0: 90, y0: 240, x1: 260, y1: 260 },
          { text: 'Sehr geehrte Damen und Herren', x0: 90, y0: 430, x1: 420, y1: 455 },
          { text: 'KPT Krankenkasse AG/KPT Versicherungen AG Seite 1 von 2', x0: 90, y0: 1120, x1: 820, y1: 1140 },
        ],
      },
    ]);

    expect(fields.sender).toBe('KPT Krankenkasse AG/KPT Versicherungen AG');
  });

  it('keeps grouped metadata sender and recipient within one green rectangle', () => {
    const fields = extractLetterFields('', 'deu', [
      {
        groupedMetadata: true,
        lines: [
          { text: 'KPT Krankenkasse AG\nPostfach 3001 Bern', x0: 80, y0: 70, x1: 360, y1: 120 },
          { text: 'Do not merge this sender addendum', x0: 80, y0: 130, x1: 360, y1: 150 },
          { text: 'Silvan Hänggi\nGablerackerstrasse 12\n8615 Wermatswil', x0: 90, y0: 280, x1: 420, y1: 350 },
          { text: 'Do not merge this recipient note', x0: 90, y0: 360, x1: 420, y1: 380 },
          { text: 'Ihr Schreiben vom 11.04.2026', x0: 90, y0: 430, x1: 520, y1: 455 },
        ],
      },
    ]);

    expect(fields.sender).toBe('KPT Krankenkasse AG\nPostfach 3001 Bern');
    expect(fields.recipient).toBe('Silvan Hänggi\nGablerackerstrasse 12\n8615 Wermatswil');
  });

  it('keeps all grouped metadata detectors within one green rectangle', () => {
    const fields = extractLetterFields('', 'eng', [
      {
        groupedMetadata: true,
        lines: [
          { text: 'Bern, 16.04.2026', x0: 620, y0: 90, x1: 820, y1: 115 },
          { text: 'Reference No.', x0: 90, y0: 180, x1: 210, y1: 205 },
          { text: '777888', x0: 90, y0: 215, x1: 180, y1: 240 },
          { text: 'Invoice No.\nINV-9001', x0: 90, y0: 260, x1: 240, y1: 310 },
          { text: 'Customer No.\nCUST-42', x0: 90, y0: 330, x1: 260, y1: 380 },
          { text: 'Account No.\nACC-12345', x0: 90, y0: 400, x1: 260, y1: 450 },
          { text: 'Payment due', x0: 90, y0: 470, x1: 220, y1: 495 },
          { text: '31.07.2026', x0: 90, y0: 510, x1: 210, y1: 535 },
          { text: 'Reply by\n15.08.2026', x0: 90, y0: 560, x1: 240, y1: 610 },
          { text: 'Subject:\nYour account statement', x0: 90, y0: 650, x1: 360, y1: 700 },
        ],
      },
    ]);

    expect(formatSentDate(fields.sentAt)).toBe('2026-04-16');
    expect(fields.sentLocation).toBe('Bern');
    expect(fields.referenceNumber).toBeUndefined();
    expect(fields.invoiceNumber).toBe('INV-9001');
    expect(fields.customerNumber).toBe('CUST-42');
    expect(fields.accountNumber).toBe('ACC-12345');
    expect(fields.paymentDueAt).toBeUndefined();
    expect(formatSentDate(fields.deadlineAt)).toBe('2026-08-15');
    expect(fields.subject).toBe('Your account statement');
  });

  it('scores grouped date rectangles by high position and short text for sent date and location', () => {
    const fields = extractLetterFields('', 'deu', [
      {
        groupedMetadata: true,
        lines: [
          { text: 'Example Bank AG', x0: 80, y0: 70, x1: 280, y1: 90 },
          { text: 'Bern, 16.04.2026', x0: 620, y0: 120, x1: 820, y1: 145 },
          {
            text: 'Die Behandlung wird bis 31.07.2026 aus der obligatorischen Krankenpflegeversicherung übernommen.',
            x0: 90,
            y0: 420,
            x1: 920,
            y1: 450,
          },
          { text: 'Zahlbar bis 01.08.2026', x0: 90, y0: 720, x1: 260, y1: 745 },
        ],
      },
    ]);

    expect(formatSentDate(fields.sentAt)).toBe('2026-04-16');
    expect(fields.sentLocation).toBe('Bern');
  });

  it('uses the best orange source rectangle inside a multi-orange green date rectangle', () => {
    const fields = extractLetterFields('', 'deu', [
      {
        groupedMetadata: true,
        lines: [
          {
            text: 'Postfach CH 3001 Bern\nBern, 16.04.2026',
            x0: 620,
            y0: 100,
            x1: 920,
            y1: 150,
            sourceRectangles: [
              { text: 'Postfach CH 3001 Bern', x0: 620, y0: 100, x1: 850, y1: 122 },
              { text: 'Bern, 16.04.2026', x0: 620, y0: 128, x1: 790, y1: 150 },
            ],
          },
          {
            text: 'Die Behandlung wird bis 31.07.2026 aus der obligatorischen Krankenpflegeversicherung übernommen.',
            x0: 90,
            y0: 420,
            x1: 920,
            y1: 450,
          },
        ],
      },
    ]);

    expect(formatSentDate(fields.sentAt)).toBe('2026-04-16');
    expect(fields.sentLocation).toBe('Bern');
  });

  it('detects grouped sent location with a named month date above other metadata lines', () => {
    const fields = extractLetterFields('', 'deu', [
      {
        groupedMetadata: true,
        lines: [
          {
            text: 'Uster, 6. Juni 2026\nMwSt.- Nummer\nAuftragsnummer',
            x0: 160,
            y0: 110,
            x1: 1250,
            y1: 590,
            sourceRectangles: [
              { text: 'Uster, 6. Juni 2026', x0: 165, y0: 120, x1: 1240, y1: 240 },
              { text: 'MwSt.- Nummer', x0: 165, y0: 300, x1: 1120, y1: 410 },
              { text: 'Auftragsnummer', x0: 165, y0: 460, x1: 1140, y1: 570 },
            ],
          },
        ],
      },
    ]);

    expect(formatSentDate(fields.sentAt)).toBe('2026-06-06');
    expect(fields.sentLocation).toBe('Uster');
  });
});
