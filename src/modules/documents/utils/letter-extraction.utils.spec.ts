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
    expect(formatSentDate(fields.paymentDueAt)).toBe('2026-07-31');
    expect(formatSentDate(fields.deadlineAt)).toBe('2026-08-15');
    expect(letterFieldsSearchText(fields)).toContain('REF-2026-7788');
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
});
