import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';
import { franc } from 'franc-min';
import { Connection, Model, PipelineStage, Types } from 'mongoose';
import { DropboxPdfFile, DropboxService } from './dropbox.service';
import { EmbeddingService } from './embedding.service';
import { PdfTextService } from './pdf-text.service';
import { SpellcheckService } from './spellcheck.service';
import { SearchDocumentsDto } from './dto/search-documents.dto';
import { SearchResultDto, SearchResultItem } from './dto/search-result.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { DocumentChunk } from './schemas/document-chunk.schema';
import { DocumentsMetadata } from './schemas/documents-metadata.schema';
import { SyncLock } from './schemas/sync-lock.schema';
import { SyncProgressEvent, SyncProgressGateway } from './sync-progress.gateway';
import { detectSentDate, formatSentDate, parseSentDateInput } from './utils/sent-date.utils';
import { buildExcerpt, buildMultiTermExcerpt, buildPartialTerms, chunkText, mergeOverlappingChunks, normalizeTerms } from './utils/text.utils';
import { SettingsService } from '../settings/settings.service';

class SyncStoppedError extends Error {
  constructor() {
    super('Dropbox sync stopped by user');
  }
}

type SyncCounters = Pick<SyncProgressEvent, 'current' | 'total' | 'imported' | 'skipped' | 'markedDeleted' | 'failed'>;
type TagMode = 'or' | 'and';
type MetadataResult = DocumentsMetadata & { _id: Types.ObjectId };
const trashTag = 'trash';
const noTagsFilterTag = 'no-symbol';

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);
  private readonly dropboxSyncLockName = 'dropbox-sync';
  private readonly syncOwnerInstanceId = randomUUID();
  private readonly syncHeartbeatIntervalMs = 5000;
  private readonly syncHeartbeatStaleMs = 30000;
  private syncHeartbeatTimer?: NodeJS.Timeout;

  constructor(
    @InjectModel(DocumentsMetadata.name) private readonly metadataModel: Model<DocumentsMetadata>,
    @InjectModel(DocumentChunk.name) private readonly chunkModel: Model<DocumentChunk>,
    @InjectModel(SyncLock.name) private readonly syncLockModel: Model<SyncLock>,
    @InjectConnection() private readonly connection: Connection,
    private readonly dropbox: DropboxService,
    private readonly embeddings: EmbeddingService,
    private readonly pdfText: PdfTextService,
    private readonly spellcheck: SpellcheckService,
    private readonly syncProgress: SyncProgressGateway,
    private readonly config: ConfigService,
    private readonly settings: SettingsService,
  ) {}

  async search(dto: SearchDocumentsDto): Promise<SearchResultDto> {
    if (this.isAllQuery(dto.q)) {
      return dto.tags.length > 0 ? this.searchByTags(dto) : this.searchAll(dto);
    }

    const hasQuery = normalizeTerms(dto.q).length > 0;
    if (!hasQuery) {
      if (dto.tags.length > 0) {
        return this.searchByTags(dto);
      }
      throw new BadRequestException('Search query or tags required');
    }

    if (dto.type === 'question' && !this.isVectorSearchEnabled()) {
      throw new BadRequestException('Vector search is disabled');
    }
    return dto.type === 'question' ? this.searchByQuestion(dto) : this.searchByQuery(dto);
  }

  async latest(limitValue?: string, tagValue?: string, tagMode: TagMode = 'or'): Promise<SearchResultDto> {
    const limit = Number(limitValue ?? '1');
    if (![1, 2, 10].includes(limit)) {
      throw new BadRequestException('Latest documents limit must be 1, 2, or 10');
    }

    const tags = await this.parseTags(tagValue);
    const tagFilter = this.documentTagFilter(tags, tagMode);
    const documents = await this.ensureSentDateStatuses(
      await this.metadataModel
      .find({ status: 'processed', ...tagFilter })
      .sort({ modifiedAtDropbox: -1, fileName: 1 })
      .limit(limit)
        .lean(),
    );
    const chunks = await this.chunkModel
      .find({ metadataId: { $in: documents.map((document) => document._id) }, deleted: false, chunkIndex: 0 })
      .lean();
    const chunkByMetadataId = new Map(chunks.map((chunk) => [String(chunk.metadataId), chunk]));

    return {
      items: documents.map((document) => {
        const chunk = chunkByMetadataId.get(String(document._id));
        const text = chunk?.text ?? '';
        return {
          documentId: String(document._id),
          title: document.title ?? document.fileName,
          fileName: document.fileName,
          tags: document.tags ?? [],
          language: document.language,
          createdAt: document.createdAtDropbox?.toISOString(),
          modifiedAt: document.modifiedAtDropbox?.toISOString(),
          sentAt: formatSentDate(document.sentAt),
          hasSentDate: document.hasSentDate ?? false,
          excerpt: text.length > 160 ? `${text.slice(0, 160)}...` : text,
          matchedTerms: [],
          textUrl: `/documents/${document._id}/text`,
          pdfUrl: document.pdfUrl,
        };
      }),
      page: 1,
      pageSize: limit,
      total: documents.length,
    };
  }

  async getDocument(id: string) {
    const document = await this.metadataModel.findById(id).lean();
    if (!document) {
      throw new NotFoundException('Document not found');
    }
    return document;
  }

  async getFullText(id: string) {
    const document = await this.getDocument(id);
    const chunks = await this.chunkModel
      .find({ metadataId: new Types.ObjectId(id), deleted: false })
      .sort({ chunkIndex: 1 })
      .lean();

    return {
      documentId: id,
      title: document.title ?? document.fileName,
      fileName: document.fileName,
      tags: document.tags ?? [],
      text: mergeOverlappingChunks(chunks.map((chunk) => chunk.text)),
    };
  }

  async updateDocument(id: string, dto: UpdateDocumentDto) {
    if (dto.title === undefined && dto.tags === undefined && dto.sentAt === undefined) {
      throw new BadRequestException('No document updates provided');
    }

    const nextTitle = dto.title?.trim();
    if (dto.title !== undefined && !nextTitle) {
      throw new BadRequestException('Document title is required');
    }

    const document = await this.getDocument(id);
    const nextTags = dto.tags === undefined ? document.tags ?? [] : await this.settings.normalizeDocumentTags(dto.tags);
    const nextSentAt = dto.sentAt === undefined || dto.sentAt === null ? undefined : parseSentDateInput(dto.sentAt);
    if (dto.sentAt !== undefined && dto.sentAt !== null && !nextSentAt) {
      throw new BadRequestException('Sent date must use yyyy-MM-dd');
    }
    const shouldUpdateTitle = nextTitle !== undefined && (document.title ?? document.fileName) !== nextTitle;
    const shouldUpdateTags = dto.tags !== undefined && !this.sameTags(document.tags ?? [], nextTags);
    const shouldUpdateSentAt =
      dto.sentAt !== undefined &&
      (formatSentDate(document.sentAt) !== formatSentDate(nextSentAt) || document.hasSentDate !== Boolean(nextSentAt));

    const chunks = await this.chunkModel
      .find({ metadataId: new Types.ObjectId(id), deleted: false })
      .select('_id text fileName')
      .lean();
    const effectiveTitle = nextTitle ?? document.title ?? document.fileName;
    const titleTerms = normalizeTerms(effectiveTitle);
    const titlePartialTerms = buildPartialTerms(effectiveTitle);

    await this.connection.transaction(async (session) => {
      const metadataSet = {
        ...(shouldUpdateTitle ? { title: nextTitle } : {}),
        ...(shouldUpdateTags ? { tags: nextTags } : {}),
        ...(shouldUpdateSentAt ? { hasSentDate: Boolean(nextSentAt) } : {}),
        ...(shouldUpdateSentAt && nextSentAt ? { sentAt: nextSentAt } : {}),
      };
      const metadataUnset = {
        ...(shouldUpdateSentAt && !nextSentAt ? { sentAt: '' } : {}),
      };
      if (Object.keys(metadataSet).length > 0 || Object.keys(metadataUnset).length > 0) {
        await this.metadataModel.updateOne(
          { _id: id },
          {
            ...(Object.keys(metadataSet).length > 0 ? { $set: metadataSet } : {}),
            ...(Object.keys(metadataUnset).length > 0 ? { $unset: metadataUnset } : {}),
          },
          { session },
        );
      }

      if (chunks.length > 0 && (shouldUpdateTitle || shouldUpdateTags)) {
        await this.chunkModel.bulkWrite(
          chunks.map((chunk) => ({
            updateOne: {
              filter: { _id: chunk._id },
              update: {
                $set: {
                  terms: Array.from(new Set([...normalizeTerms(chunk.text), ...normalizeTerms(chunk.fileName), ...titleTerms])),
                  partialTerms: Array.from(new Set([...buildPartialTerms(chunk.text), ...buildPartialTerms(chunk.fileName), ...titlePartialTerms])),
                  tags: nextTags,
                },
              },
            },
          })),
          { session },
        );
      }
    });

    const effectiveSentAt = dto.sentAt === undefined ? document.sentAt : nextSentAt;
    const effectiveHasSentDate = dto.sentAt === undefined ? document.hasSentDate ?? Boolean(document.sentAt) : Boolean(effectiveSentAt);
    return {
      documentId: id,
      title: effectiveTitle,
      fileName: document.fileName,
      tags: nextTags,
      sentAt: formatSentDate(effectiveSentAt),
      hasSentDate: effectiveHasSentDate,
    };
  }

  async getPdfLink(id: string) {
    const document = await this.getDocument(id);
    const pdfUrl = await this.dropbox.getDirectDownloadLink(document.dropboxPath);
    await this.metadataModel.updateOne({ _id: id }, { $set: { pdfUrl } });
    return { documentId: id, pdfUrl };
  }

  async startDropboxSync(): Promise<{ started: true }> {
    await this.acquireSyncLock();
    void this.executeDropboxSync().catch((error) => {
      this.logger.error('Dropbox sync background job failed', error as Error);
    });
    return { started: true };
  }

  async syncDropbox(): Promise<{ imported: number; skipped: number; markedDeleted: number; failed: number }> {
    await this.acquireSyncLock();
    return this.executeDropboxSync();
  }

  async stopDropboxSync(): Promise<{ stopRequested: true }> {
    await this.deleteStaleSyncLock();
    const lock = await this.syncLockModel
      .findOneAndUpdate(
        { name: this.dropboxSyncLockName },
        { $set: { stopRequested: true, status: 'stopping' } },
        { new: true },
      )
      .lean();

    if (!lock) {
      throw new NotFoundException('Dropbox sync is not running');
    }

    this.syncProgress.emitProgress({
      running: true,
      current: lock.current,
      total: lock.total,
      imported: lock.imported,
      skipped: lock.skipped,
      markedDeleted: lock.markedDeleted,
      failed: lock.failed,
      status: 'stopping',
      phase: lock.phase,
      fileName: lock.fileName,
      fileElapsedSeconds: lock.fileElapsedSeconds,
      startedAt: lock.startedAt.toISOString(),
    });

    return { stopRequested: true };
  }

  private async executeDropboxSync(): Promise<{ imported: number; skipped: number; markedDeleted: number; failed: number }> {
    try {
      await this.updateSyncProgress({
        running: true,
        current: 0,
        total: 0,
        imported: 0,
        skipped: 0,
        markedDeleted: 0,
        failed: 0,
        status: 'running',
        phase: 'listing',
      });
      const sourceFiles = await this.dropbox.listSourcePdfs();
      this.logger.log(`Dropbox sync found ${sourceFiles.length} PDF file(s) in source folder`);

      let imported = 0;
      let skipped = 0;
      let failed = 0;
      let current = 0;

      await this.updateSyncProgress({
        running: true,
        current,
        total: sourceFiles.length,
        imported,
        skipped,
        markedDeleted: 0,
        failed,
        status: 'running',
        phase: 'checking',
      });

      const existingSyncIdentities = await this.findExistingSyncIdentities(sourceFiles);
      const filesToImport = sourceFiles.filter((sourceFile) => !existingSyncIdentities.has(this.syncIdentityKey(sourceFile.name, this.syncDate(sourceFile))));
      skipped = sourceFiles.length - filesToImport.length;
      current = skipped;
      this.logger.log(`Dropbox sync skipped ${skipped} unchanged file(s); ${filesToImport.length} file(s) need import or retry`);

      await this.updateSyncProgress({
        running: true,
        current,
        total: sourceFiles.length,
        imported,
        skipped,
        markedDeleted: 0,
        failed,
        status: 'running',
        phase: 'checking',
      });

      for (const sourceFile of filesToImport) {
        if (await this.isSyncStopRequested()) {
          this.logger.log('Dropbox sync stop requested; stopping before next file');
          this.emitStoppedProgress(current, sourceFiles.length, imported, skipped, failed);
          return { imported, skipped, markedDeleted: 0, failed };
        }

        try {
          const importStartedAt = Date.now();
          await this.importSourceFile(
            sourceFile,
            { current, total: sourceFiles.length, imported, skipped, markedDeleted: 0, failed },
            importStartedAt,
          );
          imported += 1;
          this.logger.log(
            `Dropbox sync imported ${sourceFile.name} (${sourceFile.contentHash}) in ${Date.now() - importStartedAt}ms`,
          );
        } catch (error) {
          if (error instanceof SyncStoppedError) {
            this.logger.log(`Dropbox sync stopped while importing ${sourceFile.name}`);
            this.emitStoppedProgress(current, sourceFiles.length, imported, skipped, failed);
            return { imported, skipped, markedDeleted: 0, failed };
          }
          failed += 1;
          this.logger.error(`Failed to import ${sourceFile.name}`, error as Error);
        }

        current += 1;
        if (await this.isSyncStopRequested()) {
          this.logger.log('Dropbox sync stop requested; stopping after current file');
          this.emitStoppedProgress(current, sourceFiles.length, imported, skipped, failed);
          return { imported, skipped, markedDeleted: 0, failed };
        }
        await this.updateSyncProgress({
          running: true,
          current,
          total: sourceFiles.length,
          imported,
          skipped,
          markedDeleted: 0,
          failed,
          status: 'running',
          phase: 'checking',
        });
      }

      if (await this.isSyncStopRequested()) {
        this.logger.log('Dropbox sync stop requested; skipping deletion check');
        this.emitStoppedProgress(current, sourceFiles.length, imported, skipped, failed);
        return { imported, skipped, markedDeleted: 0, failed };
      }

      await this.updateSyncProgress({
        running: true,
        current,
        total: sourceFiles.length,
        imported,
        skipped,
        markedDeleted: 0,
        failed,
        status: 'running',
        phase: 'deleting',
      });
      const markedDeleted = await this.markMissingSourceFilesDeleted(sourceFiles);
      this.logger.log(
        `Dropbox sync completed: ${imported} imported, ${skipped} skipped, ${markedDeleted} marked deleted, ${failed} failed`,
      );
      this.syncProgress.emitProgress({
        running: false,
        current,
        total: sourceFiles.length,
        imported,
        skipped,
        markedDeleted,
        failed,
        status: 'completed',
        phase: 'idle',
      });
      return { imported, skipped, markedDeleted, failed };
    } catch (error) {
      this.syncProgress.emitProgress({
        running: false,
        current: 0,
        total: 0,
        imported: 0,
        skipped: 0,
        markedDeleted: 0,
        failed: 0,
        status: 'failed',
        phase: 'idle',
        error: (error as Error).message,
      });
      throw error;
    } finally {
      await this.releaseSyncLock();
    }
  }

  async getStatus() {
    await this.deleteStaleSyncLock();
    const [metadataCounts, chunkCount, syncLock] = await Promise.all([
      this.metadataModel.aggregate<{ _id: string; count: number }>([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      this.chunkModel.countDocuments({ deleted: false }),
      this.syncLockModel.findOne({ name: this.dropboxSyncLockName }).lean(),
    ]);

    return {
      documents: metadataCounts.reduce<Record<string, number>>((acc, item) => {
        acc[item._id] = item.count;
        return acc;
      }, {}),
      chunks: chunkCount,
      database: this.connection.name,
      sync: {
        running: Boolean(syncLock),
        startedAt: syncLock?.startedAt,
        current: syncLock?.current ?? 0,
        total: syncLock?.total ?? 0,
        status: syncLock?.status,
        phase: syncLock?.phase,
        fileName: syncLock?.fileName,
        fileElapsedSeconds: syncLock?.fileElapsedSeconds,
      },
    };
  }

  async getDropboxDiagnostics() {
    return this.dropbox.getDiagnostics();
  }

  async migratePartialTerms(): Promise<{ scanned: number; updated: number }> {
    const batchSize = 500;
    let scanned = 0;
    let updated = 0;

    while (true) {
      const chunks = await this.chunkModel
        .find({
          $or: [{ partialTerms: { $exists: false } }, { partialTerms: [] }],
        })
        .select('_id text fileName')
        .limit(batchSize)
        .lean();

      if (chunks.length === 0) {
        return { scanned, updated };
      }

      scanned += chunks.length;
      const result = await this.chunkModel.bulkWrite(
        chunks.map((chunk) => ({
          updateOne: {
            filter: { _id: chunk._id },
            update: {
              $set: {
                partialTerms: Array.from(new Set([...buildPartialTerms(chunk.text), ...buildPartialTerms(chunk.fileName)])),
              },
            },
          },
        })),
      );
      updated += result.modifiedCount;
    }
  }

  private async acquireSyncLock(): Promise<void> {
    await this.deleteStaleSyncLock();
    try {
      const now = new Date();
      await this.syncLockModel.create({
        name: this.dropboxSyncLockName,
        startedAt: now,
        ownerInstanceId: this.syncOwnerInstanceId,
        ownerProcessId: process.pid,
        heartbeatAt: now,
        current: 0,
        total: 0,
        status: 'running',
        phase: 'idle',
        imported: 0,
        skipped: 0,
        markedDeleted: 0,
        failed: 0,
      });
      this.syncProgress.emitProgress({
        running: true,
        current: 0,
        total: 0,
        imported: 0,
        skipped: 0,
        markedDeleted: 0,
        failed: 0,
        status: 'running',
        phase: 'idle',
        startedAt: now.toISOString(),
      });
      this.startSyncHeartbeat();
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        throw new ConflictException('Dropbox sync is already running');
      }
      throw error;
    }
  }

  private async releaseSyncLock(): Promise<void> {
    this.stopSyncHeartbeat();
    await this.syncLockModel.deleteOne({ name: this.dropboxSyncLockName, ownerInstanceId: this.syncOwnerInstanceId });
  }

  private async isSyncStopRequested(): Promise<boolean> {
    const lock = await this.syncLockModel
      .findOne({ name: this.dropboxSyncLockName, ownerInstanceId: this.syncOwnerInstanceId })
      .select('stopRequested')
      .lean();
    return Boolean(lock?.stopRequested);
  }

  private emitStoppedProgress(current: number, total: number, imported: number, skipped: number, failed: number): void {
    this.syncProgress.emitProgress({
      running: false,
      current,
      total,
      imported,
      skipped,
      markedDeleted: 0,
      failed,
      status: 'stopped',
      phase: 'idle',
    });
  }

  private async updateSyncProgress(progress: SyncProgressEvent): Promise<void> {
    const startedAt = await this.syncLockModel
      .findOneAndUpdate(
        { name: this.dropboxSyncLockName, ownerInstanceId: this.syncOwnerInstanceId },
        {
          $set: {
            current: progress.current,
            total: progress.total,
            status: progress.status === 'idle' ? 'running' : progress.status,
            phase: progress.phase ?? 'idle',
            imported: progress.imported,
            skipped: progress.skipped,
            markedDeleted: progress.markedDeleted,
            failed: progress.failed,
            error: progress.error,
            heartbeatAt: new Date(),
            ...(progress.fileName ? { fileName: progress.fileName } : {}),
            ...(progress.fileElapsedSeconds !== undefined ? { fileElapsedSeconds: progress.fileElapsedSeconds } : {}),
          },
          ...(progress.fileName ? {} : { $unset: { fileName: '', fileElapsedSeconds: '' } }),
        },
        { new: true },
      )
      .lean();

    this.syncProgress.emitProgress({
      ...progress,
      startedAt: startedAt?.startedAt?.toISOString(),
    });
  }

  private startSyncHeartbeat(): void {
    this.stopSyncHeartbeat();
    this.syncHeartbeatTimer = setInterval(() => {
      void this.refreshSyncHeartbeat();
    }, this.syncHeartbeatIntervalMs);
  }

  private stopSyncHeartbeat(): void {
    if (!this.syncHeartbeatTimer) {
      return;
    }
    clearInterval(this.syncHeartbeatTimer);
    this.syncHeartbeatTimer = undefined;
  }

  private async refreshSyncHeartbeat(): Promise<void> {
    await this.syncLockModel.updateOne(
      { name: this.dropboxSyncLockName, ownerInstanceId: this.syncOwnerInstanceId },
      { $set: { heartbeatAt: new Date() } },
    );
  }

  private async deleteStaleSyncLock(): Promise<void> {
    const staleBefore = new Date(Date.now() - this.syncHeartbeatStaleMs);
    const staleLock = await this.syncLockModel
      .findOne({ name: this.dropboxSyncLockName })
      .select('ownerInstanceId ownerProcessId heartbeatAt')
      .lean();

    if (!staleLock) {
      return;
    }

    const isCurrentOwner = staleLock.ownerInstanceId === this.syncOwnerInstanceId;
    const heartbeatMissing = !staleLock.heartbeatAt;
    const heartbeatStale = Boolean(staleLock.heartbeatAt && staleLock.heartbeatAt < staleBefore);
    const ownerProcessGone = !isCurrentOwner && !this.isProcessAlive(staleLock.ownerProcessId);
    if (isCurrentOwner || (!heartbeatMissing && !heartbeatStale && !ownerProcessGone)) {
      return;
    }

    await this.syncLockModel.deleteOne({ name: this.dropboxSyncLockName, _id: staleLock._id });
    this.logger.warn(
      `Removed stale Dropbox sync lock from owner ${staleLock.ownerInstanceId ?? 'unknown'} pid ${
        staleLock.ownerProcessId ?? 'unknown'
      } heartbeat ${staleLock.heartbeatAt?.toISOString() ?? 'missing'}`,
    );
    this.syncProgress.emitProgress({
      running: false,
      current: 0,
      total: 0,
      imported: 0,
      skipped: 0,
      markedDeleted: 0,
      failed: 0,
      status: 'stopped',
      phase: 'idle',
      error: 'Stale sync lock removed after missing heartbeat',
    });
  }

  private isProcessAlive(pid?: number): boolean {
    if (!pid) {
      return false;
    }

    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private async importSourceFile(sourceFile: DropboxPdfFile, counters: SyncCounters, fileStartedAt: number) {
    const metadata = await this.metadataModel.findOneAndUpdate(
      { fileName: sourceFile.name },
      {
        $set: {
          fileName: sourceFile.name,
          dropboxPath: sourceFile.pathDisplay,
          sourceDropboxPath: sourceFile.pathDisplay,
          contentHash: sourceFile.contentHash,
          dropboxId: sourceFile.id,
          status: 'pending',
          spellcheckCorrections: -1,
          ocrRotationAngle: 0,
          createdAtDropbox: sourceFile.clientModified,
          modifiedAtDropbox: this.syncDate(sourceFile),
          error: undefined,
        },
      },
      { upsert: true, new: true },
    );

    try {
      await this.emitImportPhase('downloading', sourceFile.name, counters, fileStartedAt);
      await this.throwIfSyncStopRequested();
      const pdf = await this.dropbox.download(sourceFile.pathDisplay);
      await this.throwIfSyncStopRequested();

      await this.emitImportPhase('extracting', sourceFile.name, counters, fileStartedAt);
      const extracted = await this.pdfText.extractText(pdf);
      await this.throwIfSyncStopRequested();

      const language = franc(extracted.text, { only: ['deu', 'eng', 'fra'] });
      await this.emitImportPhase('spellchecking', sourceFile.name, counters, fileStartedAt);
      await this.throwIfSyncStopRequested();
      const spellchecked = this.applySpellcheck(extracted.text, language);
      await this.throwIfSyncStopRequested();

      const analyzedText = spellchecked.text;
      const sentAt = detectSentDate(analyzedText, language);
      const chunks = chunkText(analyzedText);
      const vectorSearchEnabled = this.isVectorSearchEnabled();
      if (vectorSearchEnabled) {
        await this.emitImportPhase('embedding', sourceFile.name, counters, fileStartedAt);
        await this.throwIfSyncStopRequested();
      }
      const vectors = vectorSearchEnabled ? await this.embeddings.embedMany(chunks) : [];
      await this.throwIfSyncStopRequested();

      await this.emitImportPhase('storing', sourceFile.name, counters, fileStartedAt);
      const fileNameTerms = normalizeTerms(sourceFile.name);
      const fileNamePartialTerms = buildPartialTerms(sourceFile.name);
      const tags = metadata.tags ?? [];
      await this.chunkModel.deleteMany({ metadataId: metadata._id });
      await this.chunkModel.insertMany(
        chunks.map((text, index) => ({
          metadataId: metadata._id,
          fileName: sourceFile.name,
          chunkIndex: index,
          text,
          terms: Array.from(new Set([...normalizeTerms(text), ...fileNameTerms])),
          partialTerms: Array.from(new Set([...buildPartialTerms(text), ...fileNamePartialTerms])),
          tags,
          ...(vectorSearchEnabled ? { embedding: vectors[index] } : {}),
          deleted: false,
        })),
      );

      const pdfUrl = await this.dropbox.getDirectDownloadLink(sourceFile.pathDisplay);
      await this.metadataModel.updateOne(
        { _id: metadata._id },
        {
          $set: {
            status: 'processed',
            language: language === 'und' ? extracted.source : language,
            textLength: analyzedText.length,
            spellcheckCorrections: spellchecked.corrections,
            ocrRotationAngle: extracted.rotationAngle,
            processedAt: new Date(),
            modifiedAtDropbox: this.syncDate(sourceFile),
            hasSentDate: Boolean(sentAt),
            ...(sentAt ? { sentAt } : {}),
            pdfUrl,
          },
          $unset: { error: '', ...(sentAt ? {} : { sentAt: '' }) },
        },
      );
    } catch (error) {
      if (error instanceof SyncStoppedError) {
        throw error;
      }
      await this.metadataModel.updateOne(
        { _id: metadata._id },
        { $set: { status: 'failed', error: (error as Error).message } },
      );
      throw error;
    }
  }

  private async emitImportPhase(
    phase: NonNullable<SyncProgressEvent['phase']>,
    fileName: string,
    counters: SyncCounters,
    fileStartedAt: number,
  ) {
    await this.updateSyncProgress({
      running: true,
      ...counters,
      status: 'running',
      phase,
      fileName,
      fileElapsedSeconds: Math.max(0, Math.round((Date.now() - fileStartedAt) / 1000)),
    });
  }

  private async throwIfSyncStopRequested(): Promise<void> {
    if (await this.isSyncStopRequested()) {
      throw new SyncStoppedError();
    }
  }

  private applySpellcheck(text: string, language: string): { text: string; corrections: number } {
    if (language !== 'deu' && language !== 'eng' && language !== 'fra') {
      return { text, corrections: 0 };
    }
    return this.spellcheck.correctText(text, language);
  }

  private async markMissingSourceFilesDeleted(sourceFiles: DropboxPdfFile[]): Promise<number> {
    const activeKeys = new Set(sourceFiles.map((file) => this.syncIdentityKey(file.name, this.syncDate(file))));
    const activeMetadata = await this.metadataModel.find({ status: { $ne: 'deleted' } }).select('_id fileName modifiedAtDropbox').lean();
    const missingIds = activeMetadata
      .filter((item) => !activeKeys.has(this.syncIdentityKey(item.fileName, item.modifiedAtDropbox)))
      .map((item) => item._id);

    if (missingIds.length === 0) {
      return 0;
    }

    await this.metadataModel.updateMany(
      { _id: { $in: missingIds } },
      { $set: { status: 'deleted', deletedAt: new Date() } },
    );
    await this.chunkModel.updateMany({ metadataId: { $in: missingIds } }, { $set: { deleted: true } });
    return missingIds.length;
  }

  private async findExistingSyncIdentities(sourceFiles: DropboxPdfFile[]): Promise<Set<string>> {
    if (sourceFiles.length === 0) {
      return new Set();
    }

    const fileNames = Array.from(new Set(sourceFiles.map((file) => file.name)));
    const syncDates = Array.from(
      new Set(
        sourceFiles
          .map((file) => this.syncDate(file)?.toISOString())
          .filter((value): value is string => Boolean(value)),
      ),
    ).map((value) => new Date(value));

    const existing = await this.metadataModel
      .find({
        fileName: { $in: fileNames },
        modifiedAtDropbox: { $in: syncDates },
        $or: [
          { status: 'pending' },
          {
            status: 'processed',
            spellcheckCorrections: { $gte: 0 },
          },
        ],
      })
      .select('fileName modifiedAtDropbox')
      .lean();

    return new Set(existing.map((item) => this.syncIdentityKey(item.fileName, item.modifiedAtDropbox)));
  }

  private syncDate(file: DropboxPdfFile): Date | undefined {
    return file.serverModified ?? file.clientModified;
  }

  private syncIdentityKey(fileName: string, modifiedAt?: Date): string {
    return `${fileName}:${modifiedAt?.toISOString() ?? 'unknown'}`;
  }

  private async parseTags(value?: string): Promise<string[]> {
    return this.settings.normalizeDocumentTags(value?.split(',').map((tag) => tag.trim()).filter(Boolean), { includeSpecialFilters: true });
  }

  private sameTags(current: string[], next: string[]): boolean {
    if (current.length !== next.length) {
      return false;
    }
    const currentSet = new Set(current);
    return next.every((tag) => currentSet.has(tag));
  }

  private isAllQuery(value: string): boolean {
    return value.trim().toLowerCase() === 'all';
  }

  private async searchAll(dto: SearchDocumentsDto): Promise<SearchResultDto> {
    const skip = (dto.page - 1) * dto.pageSize;
    const filter = {
      ...(dto.includeDeleted ? {} : { status: 'processed' }),
      ...this.documentTagFilter(dto.tags, dto.tagMode),
    };
    const [documents, total] = await Promise.all([
      this.metadataModel
        .find(filter)
        .sort({ modifiedAtDropbox: -1, fileName: 1 })
        .skip(skip)
        .limit(dto.pageSize)
        .lean(),
      this.metadataModel.countDocuments(filter),
    ]);
    return this.hydrateMetadataResults(documents, dto.page, dto.pageSize, total);
  }

  private async searchByTags(dto: SearchDocumentsDto): Promise<SearchResultDto> {
    const skip = (dto.page - 1) * dto.pageSize;
    const filter = {
      ...(dto.includeDeleted ? {} : { status: 'processed' }),
      ...this.documentTagFilter(dto.tags, dto.tagMode),
    };
    const [documents, total] = await Promise.all([
      this.metadataModel
        .find(filter)
        .sort({ modifiedAtDropbox: -1, fileName: 1 })
        .skip(skip)
        .limit(dto.pageSize)
        .lean(),
      this.metadataModel.countDocuments(filter),
    ]);
    return this.hydrateMetadataResults(documents, dto.page, dto.pageSize, total);
  }

  private async hydrateMetadataResults(
    documents: MetadataResult[],
    page: number,
    pageSize: number,
    total: number,
  ): Promise<SearchResultDto> {
    documents = await this.ensureSentDateStatuses(documents);
    const chunks = await this.chunkModel.find({ metadataId: { $in: documents.map((document) => document._id) }, deleted: false, chunkIndex: 0 }).lean();
    const chunkByMetadataId = new Map(chunks.map((chunk) => [String(chunk.metadataId), chunk]));

    return {
      items: documents.map((document) => {
        const chunk = chunkByMetadataId.get(String(document._id));
        const text = chunk?.text ?? '';
        return {
          documentId: String(document._id),
          title: document.title ?? document.fileName,
          fileName: document.fileName,
          tags: document.tags ?? [],
          language: document.language,
          createdAt: document.createdAtDropbox?.toISOString(),
          modifiedAt: document.modifiedAtDropbox?.toISOString(),
          sentAt: formatSentDate(document.sentAt),
          hasSentDate: document.hasSentDate ?? false,
          excerpt: text.length > 160 ? `${text.slice(0, 160)}...` : text,
          matchedTerms: [],
          textUrl: `/documents/${document._id}/text`,
          pdfUrl: document.pdfUrl,
        };
      }),
      page,
      pageSize,
      total,
    };
  }

  private async searchByQuery(dto: SearchDocumentsDto): Promise<SearchResultDto> {
    const terms = normalizeTerms(dto.q);
    const skip = (dto.page - 1) * dto.pageSize;
    const deletedFilter = dto.includeDeleted ? {} : { deleted: false };
    const tagFilter = this.documentTagFilter(dto.tags, dto.tagMode);

    const pipeline: PipelineStage[] = [
      { $match: { ...deletedFilter, ...tagFilter, partialTerms: { $in: terms } } },
      {
        $addFields: {
          matchedTerms: {
            $filter: {
              input: terms,
              as: 'term',
              cond: { $in: ['$$term', '$partialTerms'] },
            },
          },
        },
      },
      { $addFields: { matchCount: { $size: '$matchedTerms' } } },
      { $match: { matchCount: { $gt: 0 } } },
      { $sort: { matchCount: -1 as const, updatedAt: -1 as const } },
      {
        $group: {
          _id: '$metadataId',
          chunk: { $first: '$$ROOT' },
          chunks: { $push: '$$ROOT' },
          bestMatchCount: { $max: '$matchCount' },
        },
      },
      {
        $lookup: {
          from: 'documents-metadata',
          localField: '_id',
          foreignField: '_id',
          as: 'metadata',
        },
      },
      { $unwind: '$metadata' },
      {
        $sort: {
          bestMatchCount: -1 as const,
          'metadata.modifiedAtDropbox': -1 as const,
          'metadata.fileName': 1 as const,
        },
      },
      {
        $facet: {
          items: [{ $skip: skip }, { $limit: dto.pageSize }],
          total: [{ $count: 'count' }],
        },
      },
    ];

    const [result] = await this.chunkModel.aggregate(pipeline);
    const items = await this.hydrateChunkResults(result?.items ?? [], terms);
    return {
      items,
      page: dto.page,
      pageSize: dto.pageSize,
      total: result?.total?.[0]?.count ?? 0,
    };
  }

  private async searchByQuestion(dto: SearchDocumentsDto): Promise<SearchResultDto> {
    if (!this.isVectorSearchEnabled()) {
      throw new BadRequestException('Vector search is disabled');
    }

    const embedding = await this.embeddings.embed(dto.q);
    const index = this.config.get<string>('VECTOR_INDEX_NAME') ?? 'documents_vector_index';
    const skip = (dto.page - 1) * dto.pageSize;

    const vectorSearch: Record<string, unknown> = {
      index,
      path: 'embedding',
      queryVector: embedding,
      numCandidates: Math.max(100, dto.pageSize * 10),
      limit: skip + dto.pageSize,
    };
    if (!dto.includeDeleted) {
      vectorSearch.filter = { deleted: false };
    }
    vectorSearch.filter = { ...(vectorSearch.filter as Record<string, unknown> | undefined), ...this.documentTagFilter(dto.tags, dto.tagMode) };

    const pipeline: PipelineStage[] = [
      {
        $vectorSearch: vectorSearch,
      } as PipelineStage.VectorSearch,
      { $addFields: { score: { $meta: 'vectorSearchScore' } } },
      {
        $group: {
          _id: '$metadataId',
          chunk: { $first: '$$ROOT' },
          chunks: { $push: '$$ROOT' },
          score: { $max: '$score' },
        },
      },
      { $sort: { score: -1 as const } },
      {
        $facet: {
          items: [{ $skip: skip }, { $limit: dto.pageSize }],
          total: [{ $count: 'count' }],
        },
      },
    ];

    const [result] = await this.chunkModel.aggregate(pipeline);
    const terms = normalizeTerms(dto.q);
    const items = await this.hydrateChunkResults(result?.items ?? [], terms);
    return {
      items,
      page: dto.page,
      pageSize: dto.pageSize,
      total: result?.total?.[0]?.count ?? 0,
    };
  }

  private isVectorSearchEnabled(): boolean {
    return this.config.get<string>('VECTOR_SEARCH_ENABLED') === 'true';
  }

  private documentTagFilter(tags: string[], tagMode: TagMode): Record<string, unknown> {
    if (tags.includes(noTagsFilterTag)) {
      return { $or: [{ tags: { $exists: false } }, { tags: { $size: 0 } }] };
    }
    const hasTrashFilter = tags.includes(trashTag);
    const visibleTags = tags.filter((tag) => tag !== trashTag && tag !== noTagsFilterTag);
    if (hasTrashFilter) {
      return visibleTags.length > 0 ? { tags: { $all: [trashTag, ...visibleTags] } } : { tags: trashTag };
    }
    if (visibleTags.length === 0) {
      return { tags: { $ne: trashTag } };
    }
    return { tags: { ...(tagMode === 'and' ? { $all: visibleTags } : { $in: visibleTags }), $ne: trashTag } };
  }

  private async hydrateChunkResults(results: any[], terms: string[]): Promise<SearchResultItem[]> {
    const metadataIds = results.map((result) => result._id);
    const metadata = await this.ensureSentDateStatuses(await this.metadataModel.find({ _id: { $in: metadataIds } }).lean());
    const metadataById = new Map(metadata.map((item) => [String(item._id), item]));

    return results.reduce<SearchResultItem[]>((items, result) => {
        const chunk = result.chunk;
        const chunks = result.chunks ?? [chunk];
        const document = metadataById.get(String(result._id));
        if (!document) {
          return items;
        }
        const matchedTerms: string[] = Array.from(
          new Set<string>(chunks.flatMap((item: DocumentChunk & { matchedTerms?: string[] }) => item.matchedTerms ?? [])),
        );
        items.push({
          documentId: String(document._id),
          title: document.title ?? document.fileName,
          fileName: document.fileName,
          tags: document.tags ?? [],
          language: document.language,
          createdAt: document.createdAtDropbox?.toISOString(),
          modifiedAt: document.modifiedAtDropbox?.toISOString(),
          sentAt: formatSentDate(document.sentAt),
          hasSentDate: document.hasSentDate ?? false,
          excerpt: result.bestMatchCount ? buildMultiTermExcerpt(chunks.map((item: DocumentChunk) => item.text), terms) : buildExcerpt(chunk.text, terms),
          matchedTerms: matchedTerms.length > 0 ? matchedTerms : terms.filter((term) => chunk.terms?.includes(term)),
          textUrl: `/documents/${document._id}/text`,
          pdfUrl: document.pdfUrl,
          score: result.score ?? result.bestMatchCount,
        });
        return items;
      }, []);
  }

  private async ensureSentDateStatuses(documents: MetadataResult[]): Promise<MetadataResult[]> {
    const missingStatusDocuments = documents.filter((document) => document.hasSentDate === undefined);
    if (missingStatusDocuments.length === 0) {
      return documents;
    }

    const existingSentDateUpdates = missingStatusDocuments.filter((document) => document.sentAt);
    for (const document of existingSentDateUpdates) {
      document.hasSentDate = true;
    }

    const documentsToDetect = missingStatusDocuments.filter((document) => !document.sentAt);
    const chunks = await this.chunkModel
      .find({ metadataId: { $in: documentsToDetect.map((document) => document._id) }, deleted: false })
      .sort({ metadataId: 1, chunkIndex: 1 })
      .select('metadataId text')
      .lean();
    const textByMetadataId = chunks.reduce<Map<string, string[]>>((acc, chunk) => {
      const key = String(chunk.metadataId);
      acc.set(key, [...(acc.get(key) ?? []), chunk.text]);
      return acc;
    }, new Map<string, string[]>());

    for (const document of documentsToDetect) {
      const text = mergeOverlappingChunks(textByMetadataId.get(String(document._id)) ?? []);
      const sentAt = text ? detectSentDate(text, document.language ?? '') : undefined;
      document.sentAt = sentAt;
      document.hasSentDate = Boolean(sentAt);
    }

    await this.metadataModel.bulkWrite(
      missingStatusDocuments.map((document) => ({
        updateOne: {
          filter: { _id: document._id },
          update: document.sentAt
            ? { $set: { hasSentDate: true, sentAt: document.sentAt } }
            : { $set: { hasSentDate: false }, $unset: { sentAt: '' } },
        },
      })),
    );

    return documents;
  }
}
