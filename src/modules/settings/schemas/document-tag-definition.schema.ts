import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type DocumentTagDefinitionDocument = HydratedDocument<DocumentTagDefinition>;

@Schema({ collection: 'document-tag-definitions', timestamps: true })
export class DocumentTagDefinition {
  @Prop({ required: true })
  short: string;

  @Prop({ required: true, index: true })
  text: string;

  @Prop()
  icon?: string;

  @Prop({ default: 0, index: true })
  order: number;

  @Prop({ default: false, index: true })
  hidden: boolean;
}

export const DocumentTagDefinitionSchema = SchemaFactory.createForClass(DocumentTagDefinition);
