import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../../common/auth/api-key.guard';
import { DocumentsService } from '../documents/documents.service';

@UseGuards(ApiKeyGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly documents: DocumentsService) {}

  @Get('status')
  getStatus() {
    return this.documents.getStatus();
  }

  @Post('sync')
  sync() {
    return this.documents.startDropboxSync();
  }

  @Post('sync/stop')
  stopSync() {
    return this.documents.stopDropboxSync();
  }

  @Post('migrate/partial-terms')
  migratePartialTerms() {
    return this.documents.migratePartialTerms();
  }

  @Get('dropbox')
  getDropboxDiagnostics() {
    return this.documents.getDropboxDiagnostics();
  }
}
