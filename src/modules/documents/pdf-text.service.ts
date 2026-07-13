import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import pdfParse from 'pdf-parse';
import { PNG } from 'pngjs';
import { createWorker, PSM } from 'tesseract.js';
import { LetterExtractionResult, LetterFields, LetterLayoutLine, LetterLayoutPage } from './utils/letter-extraction.utils';

const execFileAsync = promisify(execFile);
const fixedRotationAngles = [0, 90, 180, 270] as const;
const rectangleColor = { r: 255, g: 0, b: 0, a: 255 };
const mergedRectangleColor = { r: 0, g: 92, b: 255, a: 255 };
const whitespaceSplitRectangleColor = { r: 0, g: 170, b: 75, a: 255 };
const sparseTextRectangleColor = { r: 255, g: 145, b: 0, a: 255 };
const labelTextColor = { r: 255, g: 255, b: 255, a: 255 };
const metadataMarkerColor = { r: 0, g: 0, b: 0, a: 255 };
const digitGlyphs: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
};
const textGlyphs: Record<string, string[]> = {
  ...digitGlyphs,
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10011', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  ':': ['0', '1', '0', '0', '1', '0', '0'],
  '=': ['00000', '00000', '11111', '00000', '11111', '00000', '00000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '.': ['0', '0', '0', '0', '0', '1', '1'],
  ',': ['0', '0', '0', '0', '0', '1', '1'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  '#': ['01010', '01010', '11111', '01010', '11111', '01010', '01010'],
  ' ': ['000', '000', '000', '000', '000', '000', '000'],
};

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

interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface DetectionPipeline {
  png: PNG;
  sourceWidth: number;
  sourceHeight: number;
  sparseTextRectangles: LetterLayoutLine[];
  groupedRectangles: LetterLayoutLine[];
  finalRectangles: LetterLayoutLine[];
}

interface MetadataDebugAnnotation {
  rectangle: LetterLayoutLine;
  label: string;
}

type OcrDetectionTextStrategy = 'TEXTS' | 'GROUPS';
type OcrDetectionTextExtractStrategy = 'TEXTS' | 'GROUPS';

interface PdfTextExtractionResult {
  text: string;
  source: 'embedded' | 'ocr';
  rotationAngle: number;
  layoutPages: LetterLayoutPage[];
  debugDir?: string;
}

@Injectable()
export class PdfTextService {
  private readonly logger = new Logger(PdfTextService.name);

  constructor(private readonly config: ConfigService) {}

  async extractText(
    buffer: Buffer,
    onOcrProgress?: (progress: OcrProgress) => void | Promise<void>,
  ): Promise<PdfTextExtractionResult> {
    const embedded = await pdfParse(buffer);
    const embeddedText = embedded.text?.trim() ?? '';
    if (embeddedText.length > 50) {
      return { text: embeddedText, source: 'embedded', rotationAngle: 0, layoutPages: [] };
    }

    const ocr = await this.ocrPdf(buffer, onOcrProgress);
    return { text: ocr.text, source: 'ocr', rotationAngle: ocr.rotationAngle, layoutPages: ocr.layoutPages, ...(ocr.debugDir ? { debugDir: ocr.debugDir } : {}) };
  }

  private async ocrPdf(
    buffer: Buffer,
    onOcrProgress?: (progress: OcrProgress) => void | Promise<void>,
  ): Promise<{ text: string; rotationAngle: number; layoutPages: LetterLayoutPage[]; debugDir?: string }> {
    const tempRoot = this.config.get<string>('OCR_TEMP_DIR') ?? '.tmp/ocr';
    const runId = randomUUID();
    const workDir = join(process.cwd(), tempRoot, runId);
    const debugDir = this.ocrDetectionDebugEnabled() ? join(process.cwd(), tempRoot, 'debug', runId) : undefined;
    await mkdir(workDir, { recursive: true });
    if (debugDir) {
      await mkdir(debugDir, { recursive: true });
      this.logger.log(`OCR detection debug enabled. Annotated page PNGs will be written to ${debugDir}`);
    }

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
        const detectionTextStrategy = this.ocrDetectionTextStrategy();
        const textExtractStrategy = this.ocrDetectionTextExtractStrategy();
        const includeDetectionBlocks = Boolean(debugDir) || detectionTextStrategy === 'GROUPS' || textExtractStrategy === 'GROUPS';
        const firstAutoResult = await this.recognizeWithOptionalBlocks(
          worker,
          firstImagePath,
          { rotateAuto: autoRotate },
          includeDetectionBlocks,
        );
        const firstPageRotationAngle = this.detectedRotationAngle(firstFile, firstAutoResult.data.rotateRadians);
        const firstBestResult = await this.pickBestOcrResult(firstImagePath, firstFile, {
          text: firstAutoResult.data.text,
          confidence: firstAutoResult.data.confidence,
          rotationAngle: firstPageRotationAngle,
          layoutLines: this.layoutLines(firstAutoResult.data.blocks),
        }, includeDetectionBlocks);
        const rotationAngle = this.normalizeRotationAngle(firstBestResult.rotationAngle);
        this.logger.log(`OCR applying ${rotationAngle} degree document rotation to ${files.length} page(s)`);
        const groupedMetadata = detectionTextStrategy === 'GROUPS' && this.ocrDetectionMetadataKeepNewLines();
        const firstDetectionPipeline =
          debugDir || detectionTextStrategy === 'GROUPS' || textExtractStrategy === 'GROUPS' ? await this.detectionPipeline(firstImagePath, rotationAngle) : undefined;
        pages.push(this.pageText(firstBestResult.text, firstDetectionPipeline, textExtractStrategy));
        layoutPages.push({
          lines: detectionTextStrategy === 'GROUPS' ? (firstDetectionPipeline?.finalRectangles ?? []) : firstBestResult.layoutLines,
          ...(groupedMetadata ? { groupedMetadata: true } : {}),
        });
        await this.exportDetectionDebugPage(debugDir, firstImagePath, 1, firstBestResult.layoutLines, rotationAngle, firstDetectionPipeline);

        for (const [index, file] of remainingFiles.entries()) {
          const imagePath = join(workDir, file);
          await onOcrProgress?.({ currentPage: index + 2, totalPages: files.length });
          const fixedResult = await this.recognizeWithWorkerRotation(worker, imagePath, rotationAngle, includeDetectionBlocks);
          const detectionPipeline =
            debugDir || detectionTextStrategy === 'GROUPS' || textExtractStrategy === 'GROUPS' ? await this.detectionPipeline(imagePath, rotationAngle) : undefined;
          pages.push(this.pageText(fixedResult.text, detectionPipeline, textExtractStrategy));
          layoutPages.push({
            lines: detectionTextStrategy === 'GROUPS' ? (detectionPipeline?.finalRectangles ?? []) : fixedResult.layoutLines,
            ...(groupedMetadata ? { groupedMetadata: true } : {}),
          });
          await this.exportDetectionDebugPage(debugDir, imagePath, index + 2, fixedResult.layoutLines, rotationAngle, detectionPipeline);
        }

        return { text: pages.join('\n\n').trim(), rotationAngle, layoutPages, ...(debugDir ? { debugDir } : {}) };
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
    includeDetectionBlocks: boolean,
  ): Promise<OcrPageResult> {
    const result = await this.recognizeWithOptionalBlocks(
      worker,
      imagePath,
      { rotateRadians: (rotationAngle * Math.PI) / 180 },
      includeDetectionBlocks,
    );
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

  private async pickBestOcrResult(
    imagePath: string,
    fileName: string,
    autoResult: OcrPageResult,
    includeDetectionBlocks: boolean,
  ): Promise<OcrPageResult> {
    if (autoResult.confidence >= this.lowConfidenceThreshold()) {
      return autoResult;
    }

    const autoRotation = this.normalizeRotationAngle(autoResult.rotationAngle);
    const candidates = fixedRotationAngles.filter((angle) => angle !== autoRotation);
    const fixedResults = await Promise.all(
      candidates.map((angle) => this.recognizeFixedRotation(imagePath, angle, includeDetectionBlocks)),
    );
    const bestResult = [autoResult, ...fixedResults].sort((a, b) => b.confidence - a.confidence)[0];

    if (bestResult.rotationAngle !== autoResult.rotationAngle) {
      this.logger.log(
        `OCR low confidence fallback selected ${bestResult.rotationAngle} degree rotation for ${fileName} ` +
          `(auto confidence ${Math.round(autoResult.confidence)}, best confidence ${Math.round(bestResult.confidence)})`,
      );
    }

    return bestResult;
  }

  private async recognizeFixedRotation(
    imagePath: string,
    rotationAngle: 0 | 90 | 180 | 270,
    includeDetectionBlocks: boolean,
  ): Promise<OcrPageResult> {
    const worker = await createWorker(this.config.get<string>('OCR_LANGUAGES') ?? 'deu+eng+fra');
    try {
      const result = await this.recognizeWithOptionalBlocks(
        worker,
        imagePath,
        { rotateRadians: (rotationAngle * Math.PI) / 180 },
        includeDetectionBlocks,
      );
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

  private recognizeWithOptionalBlocks(
    worker: Awaited<ReturnType<typeof createWorker>>,
    imagePath: string,
    options: Parameters<Awaited<ReturnType<typeof createWorker>>['recognize']>[1],
    includeDetectionBlocks: boolean,
  ) {
    if (includeDetectionBlocks) {
      return worker.recognize(imagePath, options, { blocks: true });
    }

    return worker.recognize(imagePath, options);
  }

  async annotateMetadataDebug(
    debugDir: string | undefined,
    layoutPages: LetterLayoutPage[],
    metadata: LetterExtractionResult,
  ): Promise<void> {
    if (!debugDir) {
      return;
    }

    const annotations = this.metadataDebugAnnotations(layoutPages, metadata);
    await Promise.all(
      Array.from(annotations.entries()).map(async ([pageNumber, pageAnnotations]) => {
        const path = join(debugDir, `page-${String(pageNumber).padStart(3, '0')}-final.png`);
        try {
          const png = PNG.sync.read(await readFile(path));
          for (const annotation of pageAnnotations) {
            this.drawCircle(png, annotation.rectangle.x0, annotation.rectangle.y0, 4, metadataMarkerColor);
            this.drawText(png, annotation.label, annotation.rectangle.x0 + 10, annotation.rectangle.y0 - 6, metadataMarkerColor, 2);
          }
          await writeFile(path, PNG.sync.write(png));
        } catch (error) {
          this.logger.warn(`OCR metadata debug annotation failed for page ${pageNumber}: ${(error as Error).message}`);
        }
      }),
    );
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

  private ocrDetectionDebugEnabled(): boolean {
    return this.config.get<string>('OCR_DETECTION_DEBUG') === 'true';
  }

  private ocrDetectionTextStrategy(): OcrDetectionTextStrategy {
    return this.config.get<string>('OCR_DETECTION_TEXT_STRATEGY') === 'GROUPS' ? 'GROUPS' : 'TEXTS';
  }

  private ocrDetectionTextExtractStrategy(): OcrDetectionTextExtractStrategy {
    return this.config.get<string>('OCR_DETECTION_TEXT_EXTRACT_STRATEGY') === 'GROUPS' ? 'GROUPS' : 'TEXTS';
  }

  private ocrDetectionMetadataKeepNewLines(): boolean {
    return this.config.get<string>('OCR_DETECTION_METADATA_KEEP_NEW_LINES') === 'true';
  }

  private pageText(rawText: string, pipeline: DetectionPipeline | undefined, strategy: OcrDetectionTextExtractStrategy): string {
    if (strategy !== 'GROUPS') {
      return rawText;
    }

    return this.groupedTextFromRectangles(pipeline?.finalRectangles ?? []) || rawText;
  }

  private groupedTextFromRectangles(rectangles: LetterLayoutLine[]): string {
    return [...rectangles]
      .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
      .map((rectangle) => this.groupedRectangleText(rectangle))
      .filter(Boolean)
      .join('\n');
  }

  private groupedRectangleText(rectangle: LetterLayoutLine): string {
    const sources = rectangle.sourceRectangles;
    if (!sources || sources.length === 0) {
      return rectangle.text.replace(/[ \t]+/g, ' ').trim();
    }

    return this.joinSourcesWithLineBreaks(sources);
  }

  private joinSourcesWithLineBreaks(sources: LetterLayoutLine[]): string {
    const sorted = [...sources].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    const lines: LetterLayoutLine[][] = [];
    for (const source of sorted) {
      const currentLine = lines.at(-1);
      if (currentLine && this.sameTextLine(currentLine[0], source)) {
        currentLine.push(source);
      } else {
        lines.push([source]);
      }
    }

    return lines
      .map((line) => line.sort((a, b) => a.x0 - b.x0).map((source) => source.text.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join(' '))
      .filter(Boolean)
      .join('\n');
  }

  private sameTextLine(a: LetterLayoutLine, b: LetterLayoutLine): boolean {
    const minHeight = Math.min(a.y1 - a.y0, b.y1 - b.y0);
    return Math.abs(a.y0 - b.y0) <= 2 || this.verticalOverlap(a, b) >= minHeight * 0.5;
  }

  private async exportDetectionDebugPage(
    debugDir: string | undefined,
    imagePath: string,
    pageNumber: number,
    layoutLines: LetterLayoutLine[],
    rotationAngle: 0 | 90 | 180 | 270,
    pipeline?: DetectionPipeline,
  ): Promise<void> {
    if (!debugDir) {
      return;
    }

    try {
      const detectionPipeline = pipeline ?? (await this.detectionPipeline(imagePath, rotationAngle));
      const png = detectionPipeline.png;
      const finalPng = this.rotatedDebugPng(PNG.sync.read(await readFile(imagePath)), rotationAngle);
      const debugLayoutLines = this.rotatedRectangles(layoutLines, detectionPipeline.sourceWidth, detectionPipeline.sourceHeight, rotationAngle);
      debugLayoutLines.forEach((line, index) => {
        this.drawRectangle(png, line.x0, line.y0, line.x1, line.y1, rectangleColor);
        this.drawLabel(png, index + 1, line.x0, line.y0, rectangleColor);
      });
      detectionPipeline.sparseTextRectangles.forEach((rectangle, index) => {
        this.drawRectangle(png, rectangle.x0, rectangle.y0, rectangle.x1, rectangle.y1, sparseTextRectangleColor, 4);
        this.drawLabel(png, index + 1, rectangle.x0, rectangle.y0, sparseTextRectangleColor);
      });
      detectionPipeline.groupedRectangles.forEach((rectangle, index) => {
        this.drawRectangle(png, rectangle.x0, rectangle.y0, rectangle.x1, rectangle.y1, mergedRectangleColor, 2);
        this.drawLabel(png, index + 1, rectangle.x0, rectangle.y0, mergedRectangleColor);
      });
      detectionPipeline.finalRectangles.forEach((rectangle, index) => {
        this.drawRectangle(png, rectangle.x0, rectangle.y0, rectangle.x1, rectangle.y1, whitespaceSplitRectangleColor, -2);
        this.drawLabel(png, index + 1, rectangle.x0, rectangle.y0, whitespaceSplitRectangleColor);
        this.drawRectangle(finalPng, rectangle.x0, rectangle.y0, rectangle.x1, rectangle.y1, whitespaceSplitRectangleColor);
        this.drawLabel(finalPng, index + 1, rectangle.x0, rectangle.y0, whitespaceSplitRectangleColor);
      });
      await writeFile(join(debugDir, `page-${String(pageNumber).padStart(3, '0')}-detections.png`), PNG.sync.write(png));
      await writeFile(join(debugDir, `page-${String(pageNumber).padStart(3, '0')}-final.png`), PNG.sync.write(finalPng));
    } catch (error) {
      this.logger.warn(`OCR detection debug export failed for page ${pageNumber}: ${(error as Error).message}`);
    }
  }

  private async detectionPipeline(imagePath: string, rotationAngle: 0 | 90 | 180 | 270): Promise<DetectionPipeline> {
    const sourcePng = PNG.sync.read(await readFile(imagePath));
    const png = this.rotatedDebugPng(sourcePng, rotationAngle);
    const sparseTextRectangles = this.rotatedRectangles(
      this.normalizedRectangles(await this.sparseTextDetectionRectangles(imagePath, rotationAngle)),
      sourcePng.width,
      sourcePng.height,
      rotationAngle,
    );
    const groupedRectangles = this.closeNeighbourDetectionRectangles(sparseTextRectangles);
    const finalRectangles = this.whitespaceSplitDetectionRectangles(png, groupedRectangles, sparseTextRectangles);
    return {
      png,
      sourceWidth: sourcePng.width,
      sourceHeight: sourcePng.height,
      sparseTextRectangles,
      groupedRectangles,
      finalRectangles,
    };
  }

  private async sparseTextDetectionRectangles(
    imagePath: string,
    rotationAngle: 0 | 90 | 180 | 270,
  ): Promise<LetterLayoutLine[]> {
    const worker = await createWorker(this.config.get<string>('OCR_LANGUAGES') ?? 'deu+eng+fra');
    try {
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SPARSE_TEXT,
        preserve_interword_spaces: '1',
      });
      const result = await worker.recognize(
        imagePath,
        { rotateRadians: (rotationAngle * Math.PI) / 180 },
        { blocks: true },
      );
      return this.layoutLines(result.data.blocks);
    } finally {
      await worker.terminate();
    }
  }

  private closeNeighbourDetectionRectangles(layoutLines: LetterLayoutLine[]): LetterLayoutLine[] {
    const rectangles = this.normalizedRectangles(layoutLines);

    const merged: LetterLayoutLine[] = [];
    for (const rectangle of rectangles) {
      const target = this.closestMergeTarget(merged, rectangle);
      if (!target) {
        merged.push({ ...rectangle });
        continue;
      }

      target.text = [target.text, rectangle.text].filter(Boolean).join('\n');
      target.x0 = Math.min(target.x0, rectangle.x0);
      target.y0 = Math.min(target.y0, rectangle.y0);
      target.x1 = Math.max(target.x1, rectangle.x1);
      target.y1 = Math.max(target.y1, rectangle.y1);
    }

    return merged;
  }

  private normalizedRectangles(layoutLines: LetterLayoutLine[]): LetterLayoutLine[] {
    return layoutLines
      .map((line) => ({
        ...line,
        text: line.text.replace(/\s+/g, ' ').trim(),
        x0: Math.min(line.x0, line.x1),
        y0: Math.min(line.y0, line.y1),
        x1: Math.max(line.x0, line.x1),
        y1: Math.max(line.y0, line.y1),
      }))
      .filter((line) => line.text.length >= 2 && line.x1 > line.x0 && line.y1 > line.y0)
      .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  }

  private rotatedDebugPng(png: PNG, rotationAngle: 0 | 90 | 180 | 270): PNG {
    if (rotationAngle === 0) {
      return png;
    }

    const rotated = new PNG({
      width: rotationAngle === 180 ? png.width : png.height,
      height: rotationAngle === 180 ? png.height : png.width,
    });

    for (let y = 0; y < png.height; y += 1) {
      for (let x = 0; x < png.width; x += 1) {
        const target =
          rotationAngle === 90
            ? { x: png.height - 1 - y, y: x }
            : rotationAngle === 180
              ? { x: png.width - 1 - x, y: png.height - 1 - y }
              : { x: y, y: png.width - 1 - x };
        const sourceOffset = (png.width * y + x) << 2;
        const targetOffset = (rotated.width * target.y + target.x) << 2;
        rotated.data[targetOffset] = png.data[sourceOffset];
        rotated.data[targetOffset + 1] = png.data[sourceOffset + 1];
        rotated.data[targetOffset + 2] = png.data[sourceOffset + 2];
        rotated.data[targetOffset + 3] = png.data[sourceOffset + 3];
      }
    }

    return rotated;
  }

  private rotatedRectangles(
    rectangles: LetterLayoutLine[],
    sourceWidth: number,
    sourceHeight: number,
    rotationAngle: 0 | 90 | 180 | 270,
  ): LetterLayoutLine[] {
    return rectangles.map((rectangle) => this.rotatedRectangle(rectangle, sourceWidth, sourceHeight, rotationAngle));
  }

  private rotatedRectangle(
    rectangle: LetterLayoutLine,
    sourceWidth: number,
    sourceHeight: number,
    rotationAngle: 0 | 90 | 180 | 270,
  ): LetterLayoutLine {
    const x0 = Math.min(rectangle.x0, rectangle.x1);
    const y0 = Math.min(rectangle.y0, rectangle.y1);
    const x1 = Math.max(rectangle.x0, rectangle.x1);
    const y1 = Math.max(rectangle.y0, rectangle.y1);

    if (rotationAngle === 90) {
      return { ...rectangle, x0: sourceHeight - y1, y0: x0, x1: sourceHeight - y0, y1: x1 };
    }
    if (rotationAngle === 180) {
      return { ...rectangle, x0: sourceWidth - x1, y0: sourceHeight - y1, x1: sourceWidth - x0, y1: sourceHeight - y0 };
    }
    if (rotationAngle === 270) {
      return { ...rectangle, x0: y0, y0: sourceWidth - x1, x1: y1, y1: sourceWidth - x0 };
    }
    return { ...rectangle, x0, y0, x1, y1 };
  }

  private closestMergeTarget(rectangles: LetterLayoutLine[], below: LetterLayoutLine): LetterLayoutLine | undefined {
    return rectangles
      .filter((above) => this.isCloseVerticalNeighbour(above, below))
      .sort((a, b) => below.y0 - a.y1 - (below.y0 - b.y1))[0];
  }

  private isCloseVerticalNeighbour(above: LetterLayoutLine, below: LetterLayoutLine): boolean {
    const verticalDistance = below.y0 - above.y1;
    if (verticalDistance < 0) {
      return false;
    }

    const minHeight = Math.min(above.y1 - above.y0, below.y1 - below.y0);
    if (verticalDistance >= minHeight * 0.75) {
      return false;
    }

    return this.horizontalOverlap(above, below) > 0;
  }

  private horizontalOverlap(a: LetterLayoutLine, b: LetterLayoutLine): number {
    return Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  }

  private whitespaceSplitDetectionRectangles(
    png: PNG,
    rectangles: LetterLayoutLine[],
    textSources: LetterLayoutLine[] = rectangles,
  ): LetterLayoutLine[] {
    return rectangles.flatMap((rectangle) => this.whitespaceSplitDetectionRectangle(png, rectangle, textSources));
  }

  private whitespaceSplitDetectionRectangle(
    png: PNG,
    rectangle: LetterLayoutLine,
    textSources: LetterLayoutLine[],
  ): LetterLayoutLine[] {
    const normalized = {
      ...rectangle,
      x0: this.clamp(Math.round(Math.min(rectangle.x0, rectangle.x1)), 0, png.width - 1),
      y0: this.clamp(Math.round(Math.min(rectangle.y0, rectangle.y1)), 0, png.height - 1),
      x1: this.clamp(Math.round(Math.max(rectangle.x0, rectangle.x1)), 0, png.width - 1),
      y1: this.clamp(Math.round(Math.max(rectangle.y0, rectangle.y1)), 0, png.height - 1),
    };
    const height = normalized.y1 - normalized.y0 + 1;
    const width = normalized.x1 - normalized.x0 + 1;
    if (height <= 0 || width <= 0) {
      return [];
    }

    const minWhitespaceWidth = Math.max(12, Math.min(80, Math.round(height * 1.5)));
    const maxInkPixelsInWhitespaceColumn = Math.max(1, Math.floor(height * 0.02));
    const whitespaceRuns = this.whitespaceColumnRuns(
      png,
      normalized.x0,
      normalized.y0,
      normalized.x1,
      normalized.y1,
      maxInkPixelsInWhitespaceColumn,
    ).filter((run) => run.end - run.start + 1 >= minWhitespaceWidth);

    if (whitespaceRuns.length === 0) {
      return [this.withSegmentText(normalized, textSources)];
    }

    const segments: LetterLayoutLine[] = [];
    let segmentStart = normalized.x0;
    for (const run of whitespaceRuns) {
      const segmentEnd = run.start - 1;
      if (this.hasEnoughInk(png, segmentStart, normalized.y0, segmentEnd, normalized.y1)) {
        segments.push({ ...normalized, x0: segmentStart, x1: segmentEnd });
      }
      segmentStart = run.end + 1;
    }

    if (this.hasEnoughInk(png, segmentStart, normalized.y0, normalized.x1, normalized.y1)) {
      segments.push({ ...normalized, x0: segmentStart, x1: normalized.x1 });
    }

    return (segments.length > 1 ? segments : [normalized]).map((segment) => this.withSegmentText(segment, textSources));
  }

  private withSegmentText(segment: LetterLayoutLine, textSources: LetterLayoutLine[]): LetterLayoutLine {
    const segmentSources = textSources.filter((source) => this.sourceBelongsToSegment(source, segment));
    const text = segmentSources.length > 0 ? this.joinSegmentText(segmentSources) : segment.text;
    return { ...segment, text, ...(segmentSources.length > 0 ? { sourceRectangles: segmentSources } : {}) };
  }

  private joinSegmentText(sources: LetterLayoutLine[]): string {
    const sorted = [...sources].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    if (!this.ocrDetectionMetadataKeepNewLines()) {
      return sorted.map((source) => source.text).join(' ');
    }

    const lines: LetterLayoutLine[][] = [];
    for (const source of sorted) {
      const currentLine = lines.at(-1);
      const sameTopPosition = currentLine && Math.abs(currentLine[0].y0 - source.y0) <= 2;
      if (sameTopPosition) {
        currentLine.push(source);
      } else {
        lines.push([source]);
      }
    }

    return lines.map((line) => line.sort((a, b) => a.x0 - b.x0).map((source) => source.text).join(' ')).join('\n');
  }

  private sourceBelongsToSegment(source: LetterLayoutLine, segment: LetterLayoutLine): boolean {
    const centerX = (source.x0 + source.x1) / 2;
    return centerX >= segment.x0 && centerX <= segment.x1 && this.verticalOverlap(source, segment) > 0;
  }

  private verticalOverlap(a: LetterLayoutLine, b: LetterLayoutLine): number {
    return Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  }

  private whitespaceColumnRuns(
    png: PNG,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    maxInkPixelsInWhitespaceColumn: number,
  ): Array<{ start: number; end: number }> {
    const runs: Array<{ start: number; end: number }> = [];
    let runStart: number | undefined;

    for (let x = x0; x <= x1; x += 1) {
      const isWhitespace = this.inkPixelsInColumn(png, x, y0, y1) <= maxInkPixelsInWhitespaceColumn;
      if (isWhitespace && runStart === undefined) {
        runStart = x;
      } else if (!isWhitespace && runStart !== undefined) {
        runs.push({ start: runStart, end: x - 1 });
        runStart = undefined;
      }
    }

    if (runStart !== undefined) {
      runs.push({ start: runStart, end: x1 });
    }

    return runs;
  }

  private hasEnoughInk(png: PNG, x0: number, y0: number, x1: number, y1: number): boolean {
    if (x1 < x0) {
      return false;
    }

    let inkPixels = 0;
    for (let x = x0; x <= x1; x += 1) {
      inkPixels += this.inkPixelsInColumn(png, x, y0, y1);
      if (inkPixels >= 6) {
        return true;
      }
    }

    return false;
  }

  private inkPixelsInColumn(png: PNG, x: number, y0: number, y1: number): number {
    let count = 0;
    for (let y = y0; y <= y1; y += 1) {
      if (this.isInkPixel(png, x, y)) {
        count += 1;
      }
    }

    return count;
  }

  private isInkPixel(png: PNG, x: number, y: number): boolean {
    const offset = (png.width * y + x) << 2;
    const r = png.data[offset];
    const g = png.data[offset + 1];
    const b = png.data[offset + 2];
    const a = png.data[offset + 3];
    if (a < 128) {
      return false;
    }

    return (r + g + b) / 3 < 220;
  }

  private metadataDebugAnnotations(
    layoutPages: LetterLayoutPage[],
    metadata: LetterExtractionResult,
  ): Map<number, MetadataDebugAnnotation[]> {
    const annotationsByPage = new Map<number, Map<string, MetadataDebugAnnotation>>();

    for (const [field, value] of Object.entries(metadata.fields)) {
      const source = metadata.sources[field as keyof LetterFields];
      const rectangleReference = source ? this.metadataSourceRectangle(layoutPages, source.location) : undefined;
      if (!rectangleReference) {
        continue;
      }

      const pageAnnotations = annotationsByPage.get(rectangleReference.pageNumber) ?? new Map<string, MetadataDebugAnnotation>();
      annotationsByPage.set(rectangleReference.pageNumber, pageAnnotations);

      const key = this.rectangleKey(rectangleReference.rectangle);
      const label = `${field}=${this.metadataDebugValue(value)}`;
      const existing = pageAnnotations.get(key);
      pageAnnotations.set(key, {
        rectangle: rectangleReference.rectangle,
        label: existing ? `${existing.label} ${label}` : label,
      });
    }

    return new Map(Array.from(annotationsByPage.entries()).map(([pageNumber, annotations]) => [pageNumber, Array.from(annotations.values())]));
  }

  private metadataSourceRectangle(
    layoutPages: LetterLayoutPage[],
    location: string,
  ): { pageNumber: number; rectangle: LetterLayoutLine } | undefined {
    const pageNumber = Number(/page\s+(\d+)/iu.exec(location)?.[1] ?? 1);
    const page = layoutPages[pageNumber - 1];
    const greenRectangleIndex = /green rectangle\s+(\d+)/iu.exec(location)?.[1];
    if (greenRectangleIndex && page?.lines[Number(greenRectangleIndex) - 1]) {
      return { pageNumber, rectangle: page.lines[Number(greenRectangleIndex) - 1] };
    }

    const bbox = /bbox\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/iu.exec(location);
    if (bbox) {
      const rectangle = {
        text: '',
        x0: Number(bbox[1]),
        y0: Number(bbox[2]),
        x1: Number(bbox[3]),
        y1: Number(bbox[4]),
      };
      return { pageNumber, rectangle };
    }

    return undefined;
  }

  private metadataDebugValue(value: LetterFields[keyof LetterFields]): string {
    const displayValue = value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
    return displayValue.replace(/\s+/g, ' ').slice(0, 60);
  }

  private rectangleKey(rectangle: LetterLayoutLine): string {
    return [rectangle.x0, rectangle.y0, rectangle.x1, rectangle.y1].map((value) => Math.round(value)).join(':');
  }

  private drawRectangle(png: PNG, x0: number, y0: number, x1: number, y1: number, color: RgbaColor, inset = 0): void {
    const left = this.clamp(Math.round(Math.min(x0, x1)) - inset, 0, png.width - 1);
    const right = this.clamp(Math.round(Math.max(x0, x1)) + inset, 0, png.width - 1);
    const top = this.clamp(Math.round(Math.min(y0, y1)) - inset, 0, png.height - 1);
    const bottom = this.clamp(Math.round(Math.max(y0, y1)) + inset, 0, png.height - 1);
    if (right <= left || bottom <= top) {
      return;
    }

    for (let offset = 0; offset < 2; offset += 1) {
      this.drawHorizontalLine(png, left, right, this.clamp(top + offset, 0, png.height - 1), color);
      this.drawHorizontalLine(png, left, right, this.clamp(bottom - offset, 0, png.height - 1), color);
      this.drawVerticalLine(png, this.clamp(left + offset, 0, png.width - 1), top, bottom, color);
      this.drawVerticalLine(png, this.clamp(right - offset, 0, png.width - 1), top, bottom, color);
    }
  }

  private drawLabel(png: PNG, value: number, x: number, y: number, color: RgbaColor): void {
    const text = String(value);
    const scale = 3;
    const padding = 3;
    const digitWidth = 3 * scale;
    const digitHeight = 5 * scale;
    const gap = scale;
    const width = padding * 2 + text.length * digitWidth + Math.max(0, text.length - 1) * gap;
    const height = padding * 2 + digitHeight;
    const left = this.clamp(Math.round(x), 0, Math.max(0, png.width - width));
    const top = this.clamp(Math.round(y) - height, 0, Math.max(0, png.height - height));

    this.fillRect(png, left, top, width, height, color);
    for (const [index, digit] of Array.from(text).entries()) {
      this.drawDigit(png, digit, left + padding + index * (digitWidth + gap), top + padding, scale, labelTextColor);
    }
  }

  private drawDigit(png: PNG, digit: string, x: number, y: number, scale: number, color: RgbaColor): void {
    const glyph = digitGlyphs[digit];
    if (!glyph) {
      return;
    }

    glyph.forEach((row, rowIndex) => {
      Array.from(row).forEach((pixel, columnIndex) => {
        if (pixel === '1') {
          this.fillRect(png, x + columnIndex * scale, y + rowIndex * scale, scale, scale, color);
        }
      });
    });
  }

  private drawText(png: PNG, value: string, x: number, y: number, color: RgbaColor, scale = 1): void {
    let cursorX = this.clamp(Math.round(x), 0, png.width - 1);
    const top = this.clamp(Math.round(y), 0, png.height - 1);
    const maxGlyphWidth = 5 * scale;
    const gap = scale;

    for (const rawChar of value.toUpperCase()) {
      if (cursorX + maxGlyphWidth >= png.width) {
        break;
      }
      const glyph = textGlyphs[rawChar] ?? textGlyphs[' '];
      this.drawGlyph(png, glyph, cursorX, top, scale, color);
      cursorX += Math.max(...glyph.map((row) => row.length)) * scale + gap;
    }
  }

  private drawGlyph(png: PNG, glyph: string[], x: number, y: number, scale: number, color: RgbaColor): void {
    glyph.forEach((row, rowIndex) => {
      Array.from(row).forEach((pixel, columnIndex) => {
        if (pixel === '1') {
          this.fillRect(png, x + columnIndex * scale, y + rowIndex * scale, scale, scale, color);
        }
      });
    });
  }

  private drawCircle(png: PNG, centerX: number, centerY: number, radius: number, color: RgbaColor): void {
    const cx = Math.round(centerX);
    const cy = Math.round(centerY);
    const radiusSquared = radius * radius;
    for (let y = cy - radius; y <= cy + radius; y += 1) {
      for (let x = cx - radius; x <= cx + radius; x += 1) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= radiusSquared) {
          this.setPixel(png, this.clamp(x, 0, png.width - 1), this.clamp(y, 0, png.height - 1), color);
        }
      }
    }
  }

  private drawHorizontalLine(png: PNG, x0: number, x1: number, y: number, color: RgbaColor): void {
    for (let x = x0; x <= x1; x += 1) {
      this.setPixel(png, x, y, color);
    }
  }

  private drawVerticalLine(png: PNG, x: number, y0: number, y1: number, color: RgbaColor): void {
    for (let y = y0; y <= y1; y += 1) {
      this.setPixel(png, x, y, color);
    }
  }

  private fillRect(png: PNG, x: number, y: number, width: number, height: number, color: RgbaColor): void {
    const left = this.clamp(x, 0, png.width - 1);
    const top = this.clamp(y, 0, png.height - 1);
    const right = this.clamp(x + width - 1, 0, png.width - 1);
    const bottom = this.clamp(y + height - 1, 0, png.height - 1);

    for (let yy = top; yy <= bottom; yy += 1) {
      for (let xx = left; xx <= right; xx += 1) {
        this.setPixel(png, xx, yy, color);
      }
    }
  }

  private setPixel(png: PNG, x: number, y: number, color: RgbaColor): void {
    if (x < 0 || y < 0 || x >= png.width || y >= png.height) {
      return;
    }

    const offset = (png.width * y + x) << 2;
    png.data[offset] = color.r;
    png.data[offset + 1] = color.g;
    png.data[offset + 2] = color.b;
    png.data[offset + 3] = color.a;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }
}
