import { execFile } from 'child_process';
import { ConfigService } from '@nestjs/config';
import pdfParse from 'pdf-parse';
import { createWorker } from 'tesseract.js';
import { mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import { PNG } from 'pngjs';
import { PdfTextService } from './pdf-text.service';

jest.mock('child_process', () => ({
  execFile: jest.fn((_command, _args, callback) => callback(null, '', '')),
}));

jest.mock('fs/promises', () => ({
  mkdir: jest.fn().mockResolvedValue(undefined),
  readFile: jest.fn(),
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
  PSM: {
    SPARSE_TEXT: '11',
  },
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

  it('writes annotated OCR detection PNGs when debug is enabled', async () => {
    jest.mocked(readdir).mockResolvedValueOnce(['page-1.png'] as never);
    jest.mocked(readFile).mockResolvedValue(PNG.sync.write(createWhitespaceSplitTestPng()) as never);

    const recognize = jest.fn().mockResolvedValueOnce({
      data: {
        text: 'first page',
        confidence: 90,
        rotateRadians: null,
        blocks: [
          {
            paragraphs: [
              {
                lines: [
                  {
                    text: 'first line',
                    bbox: { x0: 5, y0: 10, x1: 120, y1: 20 },
                  },
                  {
                    text: 'second line',
                    bbox: { x0: 6, y0: 24, x1: 120, y1: 34 },
                  },
                  {
                    text: 'far line',
                    bbox: { x0: 5, y0: 50, x1: 40, y1: 60 },
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    const sparseRecognize = jest.fn().mockResolvedValueOnce({
      data: {
        text: '+41 58 310 80 65',
        confidence: 72,
        rotateRadians: null,
        blocks: [
          {
            paragraphs: [
              {
                lines: [
                  {
                    text: 'first line',
                    bbox: { x0: 5, y0: 10, x1: 120, y1: 20 },
                  },
                  {
                    text: 'second line',
                    bbox: { x0: 6, y0: 24, x1: 120, y1: 34 },
                  },
                  {
                    text: '+41 58 310 80 65',
                    bbox: { x0: 8, y0: 38, x1: 60, y1: 46 },
                  },
                  {
                    text: 'far line',
                    bbox: { x0: 5, y0: 50, x1: 40, y1: 60 },
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    const setParameters = jest.fn().mockResolvedValue(undefined);

    jest
      .mocked(createWorker)
      .mockResolvedValueOnce({
        recognize,
        terminate: jest.fn().mockResolvedValue(undefined),
      } as unknown as Awaited<ReturnType<typeof createWorker>>)
      .mockResolvedValueOnce({
        recognize: sparseRecognize,
        setParameters,
        terminate: jest.fn().mockResolvedValue(undefined),
      } as unknown as Awaited<ReturnType<typeof createWorker>>);

    const config = {
      get: jest.fn((key: string) => {
        const values: Record<string, unknown> = {
          OCR_AUTO_ROTATE: 'true',
          OCR_DETECTION_DEBUG: 'true',
          OCR_DPI: 300,
          OCR_LANGUAGES: 'deu+eng+fra',
          OCR_LOW_CONFIDENCE_THRESHOLD: 65,
          OCR_TEMP_DIR: '.tmp/ocr',
        };
        return values[key];
      }),
    } as unknown as ConfigService;
    const service = new PdfTextService(config);

    const result = await service.extractText(Buffer.from('pdf'));

    expect(result.debugDir).toMatch(/\.tmp\/ocr\/debug\//);
    expect(recognize).toHaveBeenCalledWith(expect.stringContaining('page-1.png'), { rotateAuto: true }, { blocks: true });
    expect(setParameters).toHaveBeenCalledWith({
      tessedit_pageseg_mode: '11',
      preserve_interword_spaces: '1',
    });
    expect(sparseRecognize).toHaveBeenCalledWith(
      expect.stringContaining('page-1.png'),
      { rotateRadians: 0 },
      { blocks: true },
    );
    expect(result.layoutPages).toEqual([
      {
        lines: [
          { text: 'first line', x0: 5, y0: 10, x1: 120, y1: 20 },
          { text: 'second line', x0: 6, y0: 24, x1: 120, y1: 34 },
          { text: 'far line', x0: 5, y0: 50, x1: 40, y1: 60 },
        ],
      },
    ]);
    expect(readFile).toHaveBeenCalledWith(expect.stringContaining('page-1.png'));
    expect(writeFile).toHaveBeenCalledWith(expect.stringMatching(/page-001-detections\.png$/), expect.any(Buffer));
    expect(writeFile).toHaveBeenCalledWith(expect.stringMatching(/page-001-final\.png$/), expect.any(Buffer));
    const debugWrite = jest
      .mocked(writeFile)
      .mock.calls.find(([path]) => String(path).endsWith('page-001-detections.png'));
    expect(debugWrite).toBeDefined();
    const annotatedPng = PNG.sync.read(debugWrite![1] as Buffer);
    expect(isRedPixel(annotatedPng, 60, 10)).toBe(true);
    expect(isBluePixel(annotatedPng, 3, 22)).toBe(true);
    expect(isGreenPixel(annotatedPng, 7, 22)).toBe(true);
    expect(isGreenPixel(annotatedPng, 104, 12)).toBe(true);
    expect(isOrangePixel(annotatedPng, 30, 34)).toBe(true);
    const finalWrite = jest.mocked(writeFile).mock.calls.find(([path]) => String(path).endsWith('page-001-final.png'));
    expect(finalWrite).toBeDefined();
    const finalPng = PNG.sync.read(finalWrite![1] as Buffer);
    expect(isGreenPixel(finalPng, 5, 22)).toBe(true);
    expect(isGreenPixel(finalPng, 104, 10)).toBe(true);
    expect(isRedPixel(finalPng, 60, 10)).toBe(false);
    expect(isBluePixel(finalPng, 3, 22)).toBe(false);
    expect(isOrangePixel(finalPng, 5, 22)).toBe(false);
  });

  it('rotates debug PNGs into OCR rectangle orientation before drawing', async () => {
    jest.mocked(readdir).mockResolvedValueOnce(['page-1.png'] as never);
    jest.mocked(readFile).mockResolvedValue(PNG.sync.write(createRotatedDebugTestPng()) as never);

    const recognize = jest.fn().mockResolvedValueOnce({
      data: {
        text: 'rotated page',
        confidence: 90,
        rotateRadians: Math.PI / 2,
        blocks: [
          {
            paragraphs: [
              {
                lines: [{ text: 'rotated line', bbox: { x0: 5, y0: 6, x1: 30, y1: 16 } }],
              },
            ],
          },
        ],
      },
    });
    const sparseRecognize = jest.fn().mockResolvedValueOnce({
      data: {
        text: 'rotated line',
        confidence: 90,
        rotateRadians: null,
        blocks: [
          {
            paragraphs: [
              {
                lines: [{ text: 'rotated line', bbox: { x0: 5, y0: 6, x1: 30, y1: 16 } }],
              },
            ],
          },
        ],
      },
    });

    jest
      .mocked(createWorker)
      .mockResolvedValueOnce({
        recognize,
        terminate: jest.fn().mockResolvedValue(undefined),
      } as unknown as Awaited<ReturnType<typeof createWorker>>)
      .mockResolvedValueOnce({
        recognize: sparseRecognize,
        setParameters: jest.fn().mockResolvedValue(undefined),
        terminate: jest.fn().mockResolvedValue(undefined),
      } as unknown as Awaited<ReturnType<typeof createWorker>>);

    const config = {
      get: jest.fn((key: string) => {
        const values: Record<string, unknown> = {
          OCR_AUTO_ROTATE: 'true',
          OCR_DETECTION_DEBUG: 'true',
          OCR_DPI: 300,
          OCR_LANGUAGES: 'deu+eng+fra',
          OCR_LOW_CONFIDENCE_THRESHOLD: 65,
          OCR_TEMP_DIR: '.tmp/ocr',
        };
        return values[key];
      }),
    } as unknown as ConfigService;

    const service = new PdfTextService(config);
    await service.extractText(Buffer.from('pdf'));

    const finalWrite = jest.mocked(writeFile).mock.calls.find(([path]) => String(path).endsWith('page-001-final.png'));
    expect(finalWrite).toBeDefined();
    const finalPng = PNG.sync.read(finalWrite![1] as Buffer);
    expect(finalPng.width).toBe(30);
    expect(finalPng.height).toBe(60);
    expect(isGreenPixel(finalPng, 14, 5)).toBe(true);
  });

  it('adds metadata markers to final OCR debug PNGs', async () => {
    const finalPng = new PNG({ width: 180, height: 80 });
    finalPng.data.fill(255);
    jest.mocked(readFile).mockResolvedValueOnce(PNG.sync.write(finalPng) as never);

    const config = {
      get: jest.fn(),
    } as unknown as ConfigService;
    const service = new PdfTextService(config);

    await service.annotateMetadataDebug(
      '/tmp/debug',
      [
        {
          groupedMetadata: true,
          lines: [{ text: 'Bern, 16.04.2026', x0: 10, y0: 20, x1: 120, y1: 36 }],
        },
      ],
      {
        fields: {
          sentAt: new Date(Date.UTC(2026, 3, 16)),
          sentLocation: 'Bern',
        },
        sources: {
          sentAt: { method: 'layout', location: 'page 1 scored date green rectangle bbox(10,20,120,36)' },
          sentLocation: { method: 'layout', location: 'page 1 scored date location green rectangle bbox(10,20,120,36)' },
        },
      },
    );

    const finalWrite = jest.mocked(writeFile).mock.calls.find(([path]) => String(path).endsWith('page-001-final.png'));
    expect(finalWrite).toBeDefined();
    const annotatedPng = PNG.sync.read(finalWrite![1] as Buffer);
    expect(isBlackPixel(annotatedPng, 10, 20)).toBe(true);
    expect(countBlackPixels(annotatedPng, 20, 14, 175, 32)).toBeGreaterThan(20);
  });

  it('uses final grouped rectangles for layout text when GROUPS strategy is enabled', async () => {
    jest.mocked(readdir).mockResolvedValueOnce(['page-1.png'] as never);
    jest.mocked(readFile).mockResolvedValue(PNG.sync.write(createWhitespaceSplitTestPng()) as never);

    const recognize = jest.fn().mockResolvedValueOnce({
      data: {
        text: 'first page',
        confidence: 90,
        rotateRadians: null,
        blocks: null,
      },
    });
    const sparseRecognize = jest.fn().mockResolvedValueOnce({
      data: {
        text: 'first line\nsecond line',
        confidence: 90,
        rotateRadians: null,
        blocks: [
          {
            paragraphs: [
              {
                lines: [
                  { text: 'left header', bbox: { x0: 5, y0: 10, x1: 30, y1: 20 } },
                  { text: 'right header', bbox: { x0: 102, y0: 10, x1: 120, y1: 20 } },
                  { text: 'left detail', bbox: { x0: 6, y0: 24, x1: 32, y1: 34 } },
                  { text: 'right detail', bbox: { x0: 102, y0: 24, x1: 120, y1: 34 } },
                ],
              },
            ],
          },
        ],
      },
    });

    jest
      .mocked(createWorker)
      .mockResolvedValueOnce({
        recognize,
        terminate: jest.fn().mockResolvedValue(undefined),
      } as unknown as Awaited<ReturnType<typeof createWorker>>)
      .mockResolvedValueOnce({
        recognize: sparseRecognize,
        setParameters: jest.fn().mockResolvedValue(undefined),
        terminate: jest.fn().mockResolvedValue(undefined),
      } as unknown as Awaited<ReturnType<typeof createWorker>>);

    const config = {
      get: jest.fn((key: string) => {
        const values: Record<string, unknown> = {
          OCR_AUTO_ROTATE: 'true',
          OCR_DETECTION_DEBUG: 'false',
          OCR_DETECTION_METADATA_KEEP_NEW_LINES: 'true',
          OCR_DETECTION_TEXT_STRATEGY: 'GROUPS',
          OCR_DPI: 300,
          OCR_LANGUAGES: 'deu+eng+fra',
          OCR_LOW_CONFIDENCE_THRESHOLD: 65,
          OCR_TEMP_DIR: '.tmp/ocr',
        };
        return values[key];
      }),
    } as unknown as ConfigService;

    const service = new PdfTextService(config);
    const result = await service.extractText(Buffer.from('pdf'));

    expect(recognize).toHaveBeenCalledWith(expect.stringContaining('page-1.png'), { rotateAuto: true }, { blocks: true });
    expect(sparseRecognize).toHaveBeenCalledWith(expect.stringContaining('page-1.png'), { rotateRadians: 0 }, { blocks: true });
    expect(result.layoutPages).toEqual([
      {
        groupedMetadata: true,
        lines: expect.arrayContaining([
          expect.objectContaining({ text: 'left header\nleft detail' }),
          expect.objectContaining({ text: 'right header\nright detail' }),
        ]),
      },
    ]);
    expect(writeFile).not.toHaveBeenCalledWith(expect.stringMatching(/page-001-detections\.png$/), expect.any(Buffer));
    expect(writeFile).not.toHaveBeenCalledWith(expect.stringMatching(/page-001-final\.png$/), expect.any(Buffer));
  });

  it('joins grouped rectangle metadata with spaces when newline preservation is disabled', async () => {
    jest.mocked(readdir).mockResolvedValueOnce(['page-1.png'] as never);
    jest.mocked(readFile).mockResolvedValue(PNG.sync.write(createWhitespaceSplitTestPng()) as never);

    const recognize = jest.fn().mockResolvedValueOnce({
      data: {
        text: 'first page',
        confidence: 90,
        rotateRadians: null,
        blocks: null,
      },
    });
    const sparseRecognize = jest.fn().mockResolvedValueOnce({
      data: {
        text: 'first line second line',
        confidence: 90,
        rotateRadians: null,
        blocks: [
          {
            paragraphs: [
              {
                lines: [
                  { text: 'left header', bbox: { x0: 5, y0: 10, x1: 30, y1: 20 } },
                  { text: 'left detail', bbox: { x0: 6, y0: 24, x1: 32, y1: 34 } },
                ],
              },
            ],
          },
        ],
      },
    });

    jest
      .mocked(createWorker)
      .mockResolvedValueOnce({
        recognize,
        terminate: jest.fn().mockResolvedValue(undefined),
      } as unknown as Awaited<ReturnType<typeof createWorker>>)
      .mockResolvedValueOnce({
        recognize: sparseRecognize,
        setParameters: jest.fn().mockResolvedValue(undefined),
        terminate: jest.fn().mockResolvedValue(undefined),
      } as unknown as Awaited<ReturnType<typeof createWorker>>);

    const config = {
      get: jest.fn((key: string) => {
        const values: Record<string, unknown> = {
          OCR_AUTO_ROTATE: 'true',
          OCR_DETECTION_DEBUG: 'false',
          OCR_DETECTION_METADATA_KEEP_NEW_LINES: 'false',
          OCR_DETECTION_TEXT_STRATEGY: 'GROUPS',
          OCR_DPI: 300,
          OCR_LANGUAGES: 'deu+eng+fra',
          OCR_LOW_CONFIDENCE_THRESHOLD: 65,
          OCR_TEMP_DIR: '.tmp/ocr',
        };
        return values[key];
      }),
    } as unknown as ConfigService;

    const service = new PdfTextService(config);
    const result = await service.extractText(Buffer.from('pdf'));

    expect(result.layoutPages).toEqual([
      {
        lines: expect.arrayContaining([expect.objectContaining({ text: 'left header left detail' })]),
      },
    ]);
  });

  it('extracts page text from sorted green rectangles when GROUPS text extraction is enabled', async () => {
    jest.mocked(readdir).mockResolvedValueOnce(['page-1.png'] as never);
    jest.mocked(readFile).mockResolvedValue(PNG.sync.write(createWhitespaceSplitTestPng()) as never);

    const recognize = jest.fn().mockResolvedValueOnce({
      data: {
        text: 'raw tesseract text',
        confidence: 90,
        rotateRadians: null,
        blocks: null,
      },
    });
    const sparseRecognize = jest.fn().mockResolvedValueOnce({
      data: {
        text: 'left header right header left detail right detail',
        confidence: 90,
        rotateRadians: null,
        blocks: [
          {
            paragraphs: [
              {
                lines: [
                  { text: 'right header', bbox: { x0: 102, y0: 10, x1: 120, y1: 20 } },
                  { text: 'left header', bbox: { x0: 5, y0: 10, x1: 30, y1: 20 } },
                  { text: 'right detail', bbox: { x0: 102, y0: 24, x1: 120, y1: 34 } },
                  { text: 'left detail', bbox: { x0: 6, y0: 24, x1: 32, y1: 34 } },
                ],
              },
            ],
          },
        ],
      },
    });

    jest
      .mocked(createWorker)
      .mockResolvedValueOnce({
        recognize,
        terminate: jest.fn().mockResolvedValue(undefined),
      } as unknown as Awaited<ReturnType<typeof createWorker>>)
      .mockResolvedValueOnce({
        recognize: sparseRecognize,
        setParameters: jest.fn().mockResolvedValue(undefined),
        terminate: jest.fn().mockResolvedValue(undefined),
      } as unknown as Awaited<ReturnType<typeof createWorker>>);

    const config = {
      get: jest.fn((key: string) => {
        const values: Record<string, unknown> = {
          OCR_AUTO_ROTATE: 'true',
          OCR_DETECTION_DEBUG: 'false',
          OCR_DETECTION_METADATA_KEEP_NEW_LINES: 'false',
          OCR_DETECTION_TEXT_EXTRACT_STRATEGY: 'GROUPS',
          OCR_DETECTION_TEXT_STRATEGY: 'TEXTS',
          OCR_DPI: 300,
          OCR_LANGUAGES: 'deu+eng+fra',
          OCR_LOW_CONFIDENCE_THRESHOLD: 65,
          OCR_TEMP_DIR: '.tmp/ocr',
        };
        return values[key];
      }),
    } as unknown as ConfigService;

    const service = new PdfTextService(config);
    const result = await service.extractText(Buffer.from('pdf'));

    expect(recognize).toHaveBeenCalledWith(expect.stringContaining('page-1.png'), { rotateAuto: true }, { blocks: true });
    expect(sparseRecognize).toHaveBeenCalledWith(expect.stringContaining('page-1.png'), { rotateRadians: 0 }, { blocks: true });
    expect(result.text).toBe('left header\nleft detail\nright header\nright detail');
    expect(result.layoutPages).toEqual([{ lines: [] }]);
  });
});

function createWhitespaceSplitTestPng(): PNG {
  const png = new PNG({ width: 140, height: 80 });
  png.data.fill(255);
  fillTestRect(png, 8, 12, 18, 18);
  fillTestRect(png, 8, 26, 20, 32);
  fillTestRect(png, 102, 12, 114, 18);
  fillTestRect(png, 102, 26, 116, 32);
  fillTestRect(png, 8, 52, 30, 58);
  return png;
}

function createRotatedDebugTestPng(): PNG {
  const png = new PNG({ width: 60, height: 30 });
  png.data.fill(255);
  fillTestRect(png, 10, 8, 20, 18);
  return png;
}

function fillTestRect(png: PNG, x0: number, y0: number, x1: number, y1: number): void {
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const offset = (png.width * y + x) << 2;
      png.data[offset] = 0;
      png.data[offset + 1] = 0;
      png.data[offset + 2] = 0;
      png.data[offset + 3] = 255;
    }
  }
}

function isRedPixel(png: PNG, x: number, y: number): boolean {
  const offset = (png.width * y + x) << 2;
  return png.data[offset] === 255 && png.data[offset + 1] === 0 && png.data[offset + 2] === 0;
}

function isBluePixel(png: PNG, x: number, y: number): boolean {
  const offset = (png.width * y + x) << 2;
  return png.data[offset] === 0 && png.data[offset + 1] === 92 && png.data[offset + 2] === 255;
}

function isGreenPixel(png: PNG, x: number, y: number): boolean {
  const offset = (png.width * y + x) << 2;
  return png.data[offset] === 0 && png.data[offset + 1] === 170 && png.data[offset + 2] === 75;
}

function isOrangePixel(png: PNG, x: number, y: number): boolean {
  const offset = (png.width * y + x) << 2;
  return png.data[offset] === 255 && png.data[offset + 1] === 145 && png.data[offset + 2] === 0;
}

function isBlackPixel(png: PNG, x: number, y: number): boolean {
  const offset = (png.width * y + x) << 2;
  return png.data[offset] === 0 && png.data[offset + 1] === 0 && png.data[offset + 2] === 0;
}

function countBlackPixels(png: PNG, x0: number, y0: number, x1: number, y1: number): number {
  let count = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      if (isBlackPixel(png, x, y)) {
        count += 1;
      }
    }
  }
  return count;
}
