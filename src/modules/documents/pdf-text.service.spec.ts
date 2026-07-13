import { execFile } from 'child_process';
import { ConfigService } from '@nestjs/config';
import pdfParse from 'pdf-parse';
import { createWorker } from 'tesseract.js';
import { mkdir, readdir, rm, writeFile } from 'fs/promises';
import { PdfTextService } from './pdf-text.service';

jest.mock('child_process', () => ({
  execFile: jest.fn((_command, _args, callback) => callback(null, '', '')),
}));

jest.mock('fs/promises', () => ({
  mkdir: jest.fn().mockResolvedValue(undefined),
  readdir: jest.fn().mockResolvedValue(['page-1.png', 'page-2.png', 'page-3.png']),
  rm: jest.fn().mockResolvedValue(undefined),
  writeFile: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('pdf-parse', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('tesseract.js', () => ({
  createWorker: jest.fn(),
}));

describe('PdfTextService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(pdfParse).mockResolvedValue({
      text: '',
      numpages: 3,
      numrender: 3,
      info: {},
      metadata: null,
      version: 'v1.10.100',
    });
  });

  it('detects OCR rotation once and applies it to every remaining page', async () => {
    const recognize = jest
      .fn()
      .mockResolvedValueOnce({
        data: {
          text: 'first page',
          confidence: 90,
          rotateRadians: Math.PI / 2,
        },
      })
      .mockResolvedValueOnce({
        data: {
          text: 'second page',
          confidence: 88,
          rotateRadians: null,
        },
      })
      .mockResolvedValueOnce({
        data: {
          text: 'third page',
          confidence: 86,
          rotateRadians: null,
        },
      });

    jest.mocked(createWorker).mockResolvedValue({
      recognize,
      terminate: jest.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<typeof createWorker>>);

    const config = {
      get: jest.fn((key: string) => {
        const values: Record<string, unknown> = {
          OCR_AUTO_ROTATE: 'true',
          OCR_DPI: 300,
          OCR_LANGUAGES: 'deu+eng+fra',
          OCR_LOW_CONFIDENCE_THRESHOLD: 65,
          OCR_TEMP_DIR: '.tmp/ocr',
        };
        return values[key];
      }),
    } as unknown as ConfigService;
    const service = new PdfTextService(config);
    const onOcrProgress = jest.fn();

    const result = await service.extractText(Buffer.from('pdf'), onOcrProgress);

    expect(execFile).toHaveBeenCalledWith(
      'pdftoppm',
      expect.arrayContaining(['-png', '-r', '300']),
      expect.any(Function),
    );
    expect(mkdir).toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalled();
    expect(readdir).toHaveBeenCalled();
    expect(rm).toHaveBeenCalled();
    expect(recognize).toHaveBeenCalledTimes(3);
    expect(recognize).toHaveBeenNthCalledWith(1, expect.stringContaining('page-1.png'), { rotateAuto: true });
    expect(recognize).toHaveBeenNthCalledWith(2, expect.stringContaining('page-2.png'), {
      rotateRadians: Math.PI / 2,
    });
    expect(recognize).toHaveBeenNthCalledWith(3, expect.stringContaining('page-3.png'), {
      rotateRadians: Math.PI / 2,
    });
    expect(onOcrProgress).toHaveBeenNthCalledWith(1, { currentPage: 1, totalPages: 3 });
    expect(onOcrProgress).toHaveBeenNthCalledWith(2, { currentPage: 2, totalPages: 3 });
    expect(onOcrProgress).toHaveBeenNthCalledWith(3, { currentPage: 3, totalPages: 3 });
    expect(result).toEqual({
      text: 'first page\n\nsecond page\n\nthird page',
      source: 'ocr',
      rotationAngle: 90,
      layoutPages: [{ lines: [] }, { lines: [] }, { lines: [] }],
    });
  });
});
