import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AdminModule } from './modules/admin/admin.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { DropboxOauthModule } from './modules/dropbox-oauth/dropbox-oauth.module';
import { HealthModule } from './modules/health/health.module';
import { SettingsModule } from './modules/settings/settings.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.getOrThrow<string>('MONGODB_URI'),
        dbName: config.get<string>('MONGODB_DB_NAME') ?? 'my-document-store-local',
      }),
    }),
    HealthModule,
    DocumentsModule,
    DropboxOauthModule,
    SettingsModule,
    AdminModule,
  ],
})
export class AppModule {}
