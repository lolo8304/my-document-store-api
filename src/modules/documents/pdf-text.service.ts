import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { mkdir, readdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import pdfParse from 'pdf-parse';
import { createWorker } from 'tesseract.js';
import { LetterLayoutLine, LetterLayoutPage } from './utils/letter-extraction.utils';

const execFileAsync = promisify(execFile);
const fixedRotationAngles = [0, 90, 180, 270] as const;

interface OcrPageResult {
  text: string;
  confidence: number;
  rotationAngle: number;
  layoutLines: LetterLayoutLine[];
}

interface OcrProgress {
  currentPage: number;
  totalPages: number;
}

interface OcrBlock {
  paragraphs: Array<{
    lines: Array<{
      text: string;
      bbox: {
        x0: number;
        y0: number;
        x1: number;
        y1: number;
      };
    }>;
  }>;
}

@Injectable()
export class PdfTextService {
  private readonly logger = new Logger(PdfTextService.name);

  constructor(private readonly config: ConfigService) {}

  async extractText(
    buffer: Buffer,
    onOcrProgress?: (progress: OcrProgress) => void | Promise<void>,
  ): Promise<{ text: string; source: 'embedded' | 'ocr'; rotationAngle: number; layoutPages: LetterLayoutPage[] }> {
    const embedded = await pdfParse(buffer);
    const embeddedText = embedded.text?.trim() ?? '';
    if (embeddedText.length > 50) {
      return { text: embeddedText, source: 'embedded', rotationAngle: 0, layoutPages: [] };
    }

    const ocr = await this.ocrPdf(buffer, onOcrProgress);
    return { text: ocr.text, source: 'ocr', rotationAngle: ocr.rotationAngle, layoutPages: ocr.layoutPages };
  }

  private async ocrPdf(
    buffer: Buffer,
    onOcrProgress?: (progress: OcrProgress) => void | Promise<void>,
  ): Promise<{ text: string; rotationAngle: number; layoutPages: LetterLayoutPage[] }> {
    const tempRoot = this.config.get<string>('OCR_TEMP_DIR') ?? '.tmp/ocr';
    const workDir = join(process.cwd(), tempRoot, randomUUID());
    await mkdir(workDir, { recursive: true });

    try {
      const pdfPath = join(workDir, 'document.pdf');
      const imagePrefix = join(workDir, 'page');
      await writeFile(pdfPath, buffer);
      await execFileAsync('pdftoppm', ['-png', '-r', this.ocrDpi(), pdfPath, imagePrefix]);

      const files = (await readdir(workDir))
        .filter((file) => file.endsWith('.png'))
        .sort((a, b) => a.localeCompare(b));

      const worker = await createWorker(this.config.get<string>('OCR_LANGUAGES') ?? 'deu+eng+fra');
      try {
        const pages: string[] = [];
        const layoutPages: LetterLayoutPage[] = [];
        const autoRotate = this.config.get<string>('OCR_AUTO_ROTATE') !== 'false';

        if (files.length === 0) {
          return { text: '', rotationAngle: 0, layoutPages: [] };
        }

        const [firstFile, ...remainingFiles] = files;
        const firstImagePath = join(workDir, firstFile);
        await onOcrProgress?.({ currentPage: 1, totalPages: files.length });
        const firstAutoResult = await worker.recognize(firstImagePath, { rotateAuto: autoRotate });
        const firstPageRotationAngle = this.detectedRotationAngle(firstFile, firstAutoResult.data.rotateRadians);
        const firstBestResult = await this.pickBestOcrResult(firstImagePath, firstFile, {
          text: firstAutoResult.data.text,
          confidence: firstAutoResult.data.confidence,
          rotationAngle: firstPageRotationAngle,
          layoutLines: this.layoutLines(firstAutoResult.data.blocks),
        });
        const rotationAngle = this.normalizeRotationAngle(firstBestResult.rotationAngle);
        this.logger.log(`OCR applying ${rotationAngle} degree document rotation to ${files.length} page(s)`);
        pages.push(firstBestResult.text);
        layoutPages.push({ lines: firstBestResult.layoutLines });

        for (const [index, file] of remainingFiles.entries()) {
          const imagePath = join(workDir, file);
          await onOcrProgress?.({ currentPage: index + 2, totalPages: files.length });
          const fixedResult = await this.recognizeWithWorkerRotation(worker, imagePath, rotationAngle);
          pages.push(fixedResult.text);
          layoutPages.push({ lines: fixedResult.layoutLines });
        }

        return { text: pages.join('\n\n').trim(), rotationAngle, layoutPages };
      } finally {
        await worker.terminate();
      }
    } catch (error) {
      this.logger.error('OCR failed. Ensure poppler is installed so pdftoppm is available.', error as Error);
      throw error;
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  private async recognizeWithWorkerRotation(
    worker: Awaited<ReturnType<typeof createWorker>>,
    imagePath: string,
    rotationAngle: 0 | 90 | 180 | 270,
  ): Promise<OcrPageResult> {
    const result = await worker.recognize(imagePath, { rotateRadians: (rotationAngle * Math.PI) / 180 });
    return {
      text: result.data.text,
      confidence: result.data.confidence,
      rotationAngle,
      layoutLines: this.layoutLines(result.data.blocks),
    };
  }

  private layoutLines(blocks: OcrBlock[] | null): LetterLayoutLine[] {
    return (blocks ?? []).flatMap((block) =>
      block.paragraphs.flatMap((paragraph) =>
        paragraph.lines.map((line) => ({
          text: line.text,
          x0: line.bbox.x0,
          y0: line.bbox.y0,
          x1: line.bbox.x1,
          y1: line.bbox.y1,
        })),
      ),
    );
  }

  private detectedRotationAngle(fileName: string, rotateRadians: number | null): number {
    if (!rotateRadians || Math.abs(rotateRadians) < 0.005) {
      return 0;
    }

    const degrees = Math.round((rotateRadians * 180) / Math.PI);
    this.logger.log(`OCR auto-rotated ${fileName} by ${degrees} degree(s) before text detection`);
    return degrees;
  }

  private async pickBestOcrResult(imagePath: string, fileName: string, autoResult: OcrPageResult): Promise<OcrPageResult> {
    if (autoResult.confidence >= this.lowConfidenceThreshold()) {
      return autoResult;
    }

    const autoRotation = this.normalizeRotationAngle(autoResult.rotationAngle);
    const candidates = fixedRotationAngles.filter((angle) => angle !== autoRotation);
    const fixedResults = await Promise.all(candidates.map((angle) => this.recognizeFixedRotation(imagePath, angle)));
    const bestResult = [autoResult, ...fixedResults].sort((a, b) => b.confidence - a.confidence)[0];

    if (bestResult.rotationAngle !== autoResult.rotationAngle) {
      this.logger.log(
        `OCR low confidence fallback selected ${bestResult.rotationAngle} degree rotation for ${fileName} ` +
          `(auto confidence ${Math.round(autoResult.confidence)}, best confidence ${Math.round(bestResult.confidence)})`,
      );
    }

    return bestResult;
  }

  private async recognizeFixedRotation(imagePath: string, rotationAngle: 0 | 90 | 180 | 270): Promise<OcrPageResult> {
    const worker = await createWorker(this.config.get<string>('OCR_LANGUAGES') ?? 'deu+eng+fra');
    try {
      const result = await worker.recognize(imagePath, { rotateRadians: (rotationAngle * Math.PI) / 180 });
      return {
        text: result.data.text,
        confidence: result.data.confidence,
        rotationAngle,
        layoutLines: this.layoutLines(result.data.blocks),
      };
    } finally {
      await worker.terminate();
    }
  }

  private normalizeRotationAngle(rotationAngle: number): 0 | 90 | 180 | 270 {
    const normalized = ((Math.round(rotationAngle / 90) * 90) % 360 + 360) % 360;
    return fixedRotationAngles.includes(normalized as 0 | 90 | 180 | 270) ? (normalized as 0 | 90 | 180 | 270) : 0;
  }

  private ocrDpi(): string {
    return String(this.config.get<number>('OCR_DPI') ?? 300);
  }

  private lowConfidenceThreshold(): number {
    return this.config.get<number>('OCR_LOW_CONFIDENCE_THRESHOLD') ?? 65;
  }
}
