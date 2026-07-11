import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DocumentTagDefinition, DocumentTagDefinitionSchema } from './schemas/document-tag-definition.schema';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

@Module({
  imports: [MongooseModule.forFeature([{ name: DocumentTagDefinition.name, schema: DocumentTagDefinitionSchema }])],
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
