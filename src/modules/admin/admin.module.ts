import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { AdminController } from './admin.controller';
import { SyncScheduler } from './sync.scheduler';

@Module({
  imports: [DocumentsModule],
  controllers: [AdminController],
  providers: [SyncScheduler],
})
export class AdminModule {}
