import { ConflictException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentsService } from '../documents/documents.service';

@Injectable()
export class SyncScheduler implements OnModuleInit {
  private readonly logger = new Logger(SyncScheduler.name);
  private readonly defaultIntervalSeconds = 30 * 60;

  constructor(
    private readonly config: ConfigService,
    private readonly documents: DocumentsService,
  ) {}

  onModuleInit() {
    const intervalSeconds = this.config.get<number>('DROPBOX_SYNC_INTERVAL_SECONDS') ?? this.defaultIntervalSeconds;
    setInterval(() => void this.runOnce(), intervalSeconds * 1000);
  }

  private async runOnce() {
    try {
      const result = await this.documents.startDropboxSync();
      this.logger.log(`Dropbox sync start requested: ${JSON.stringify(result)}`);
    } catch (error) {
      if (error instanceof ConflictException) {
        this.logger.log('Dropbox sync already running; scheduled sync skipped');
        return;
      }
      this.logger.error('Dropbox sync failed', error as Error);
    }
  }
}
