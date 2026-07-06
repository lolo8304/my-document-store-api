import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type DocumentChunkDocument = HydratedDocument<DocumentChunk>;

@Schema({ collection: 'documents', timestamps: true })
export class DocumentChunk {
  @Prop({ type: Types.ObjectId, ref: 'DocumentMetadata', required: true, index: true })
  metadataId: Types.ObjectId;

  @Prop({ required: true, index: true })
  fileName: string;

  @Prop({ required: true })
  chunkIndex: number;

  @Prop({ required: true })
  text: string;

  @Prop({ type: [Number] })
  embedding: number[];

  @Prop({ type: [String], index: true })
  terms: string[];

  @Prop({ default: false, index: true })
  deleted: boolean;
}

export const DocumentChunkSchema = SchemaFactory.createForClass(DocumentChunk);
DocumentChunkSchema.index({ text: 'text', fileName: 'text', terms: 'text' });
DocumentChunkSchema.index({ metadataId: 1, chunkIndex: 1 }, { unique: true });
