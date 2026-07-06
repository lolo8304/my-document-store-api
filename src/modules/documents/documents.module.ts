import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DocumentChunk, DocumentChunkSchema } from './schemas/document-chunk.schema';
import { DocumentsMetadata, DocumentsMetadataSchema } from './schemas/documents-metadata.schema';
import { SyncLock, SyncLockSchema } from './schemas/sync-lock.schema';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { DropboxService } from './dropbox.service';
import { EmbeddingService } from './embedding.service';
import { PdfTextService } from './pdf-text.service';
import { SpellcheckService } from './spellcheck.service';
import { SyncProgressGateway } from './sync-progress.gateway';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DocumentsMetadata.name, schema: DocumentsMetadataSchema },
      { name: DocumentChunk.name, schema: DocumentChunkSchema },
      { name: SyncLock.name, schema: SyncLockSchema },
    ]),
  ],
  controllers: [DocumentsController],
  providers: [DocumentsService, DropboxService, EmbeddingService, PdfTextService, SpellcheckService, SyncProgressGateway],
  exports: [DocumentsService, DropboxService],
})
export class DocumentsModule {}
