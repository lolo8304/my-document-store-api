import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { mkdir, readdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import pdfParse from 'pdf-parse';
import { createWorker } from 'tesseract.js';

const execFileAsync = promisify(execFile);
const fixedRotationAngles = [0, 90, 180, 270] as const;

interface OcrPageResult {
  text: string;
  confidence: number;
  rotationAngle: number;
}

@Injectable()
export class PdfTextService {
  private readonly logger = new Logger(PdfTextService.name);

  constructor(private readonly config: ConfigService) {}

  async extractText(buffer: Buffer): Promise<{ text: string; source: 'embedded' | 'ocr'; rotationAngle: number }> {
    const embedded = await pdfParse(buffer);
    const embeddedText = embedded.text?.trim() ?? '';
    if (embeddedText.length > 50) {
      return { text: embeddedText, source: 'embedded', rotationAngle: 0 };
    }

    const ocr = await this.ocrPdf(buffer);
    return { text: ocr.text, source: 'ocr', rotationAngle: ocr.rotationAngle };
  }

  private async ocrPdf(buffer: Buffer): Promise<{ text: string; rotationAngle: number }> {
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
        let rotationAngle = 0;
        const autoRotate = this.config.get<string>('OCR_AUTO_ROTATE') !== 'false';
        for (const file of files) {
          const imagePath = join(workDir, file);
          const autoResult = await worker.recognize(imagePath, { rotateAuto: autoRotate });
          const pageRotationAngle = this.detectedRotationAngle(file, autoResult.data.rotateRadians);
          const bestResult = await this.pickBestOcrResult(imagePath, file, {
            text: autoResult.data.text,
            confidence: autoResult.data.confidence,
            rotationAngle: pageRotationAngle,
          });

          if (Math.abs(bestResult.rotationAngle) > Math.abs(rotationAngle)) {
            rotationAngle = bestResult.rotationAngle;
          }
          pages.push(bestResult.text);
        }
        return { text: pages.join('\n\n').trim(), rotationAngle };
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
