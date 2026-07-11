import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type DocumentsMetadataDocument = HydratedDocument<DocumentsMetadata>;

@Schema({ collection: 'documents-metadata', timestamps: true })
export class DocumentsMetadata {
  @Prop({ required: true, unique: true, index: true })
  fileName: string;

  @Prop({ index: true })
  title?: string;

  @Prop({ type: [String], default: [], index: true })
  tags: string[];

  @Prop({ required: true, index: true })
  dropboxPath: string;

  @Prop({ required: true })
  sourceDropboxPath: string;

  @Prop({ required: true, index: true })
  contentHash: string;

  @Prop({ required: true })
  dropboxId: string;

  @Prop()
  pdfUrl?: string;

  @Prop({ required: true, enum: ['pending', 'processed', 'failed', 'deleted'], index: true })
  status: 'pending' | 'processed' | 'failed' | 'deleted';

  @Prop()
  language?: string;

  @Prop({ default: 0 })
  textLength: number;

  @Prop({ default: -1 })
  spellcheckCorrections: number;

  @Prop({ default: 0 })
  ocrRotationAngle: number;

  @Prop()
  createdAtDropbox?: Date;

  @Prop()
  modifiedAtDropbox?: Date;

  @Prop()
  processedAt?: Date;

  @Prop()
  deletedAt?: Date;

  @Prop()
  error?: string;
}

export const DocumentsMetadataSchema = SchemaFactory.createForClass(DocumentsMetadata);
