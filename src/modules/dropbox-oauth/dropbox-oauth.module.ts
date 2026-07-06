import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { DropboxOauthController } from './dropbox-oauth.controller';

@Module({
  imports: [DocumentsModule],
  controllers: [DropboxOauthController],
})
export class DropboxOauthModule {}
