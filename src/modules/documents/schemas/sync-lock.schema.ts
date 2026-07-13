import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SyncLockDocument = HydratedDocument<SyncLock>;

@Schema({ collection: 'sync-locks', timestamps: true })
export class SyncLock {
  @Prop({ required: true, unique: true, index: true })
  name: string;

  @Prop({ required: true })
  startedAt: Date;

  @Prop({ required: true })
  ownerInstanceId: string;

  @Prop({ required: true })
  ownerProcessId: number;

  @Prop({ required: true })
  heartbeatAt: Date;

  @Prop({ default: 0 })
  current: number;

  @Prop({ default: 0 })
  total: number;

  @Prop({ required: true, enum: ['running', 'stopping', 'completed', 'failed', 'stopped'], default: 'running' })
  status: 'running' | 'stopping' | 'completed' | 'failed' | 'stopped';

  @Prop({ default: false })
  stopRequested: boolean;

  @Prop({
    enum: ['idle', 'listing', 'checking', 'downloading', 'extracting', 'spellchecking', 'embedding', 'storing', 'deleting'],
    default: 'idle',
  })
  phase: 'idle' | 'listing' | 'checking' | 'downloading' | 'extracting' | 'spellchecking' | 'embedding' | 'storing' | 'deleting';

  @Prop()
  fileName?: string;

  @Prop()
  fileElapsedSeconds?: number;

  @Prop()
  stepCurrent?: number;

  @Prop()
  stepTotal?: number;

  @Prop({ enum: ['page', 'chunk'] })
  stepUnit?: 'page' | 'chunk';

  @Prop({ default: 0 })
  imported: number;

  @Prop({ default: 0 })
  skipped: number;

  @Prop({ default: 0 })
  markedDeleted: number;

  @Prop({ default: 0 })
  failed: number;

  @Prop()
  error?: string;
}

export const SyncLockSchema = SchemaFactory.createForClass(SyncLock);
