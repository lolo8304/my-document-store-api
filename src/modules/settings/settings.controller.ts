import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiKeyGuard } from '../../common/auth/api-key.guard';
import { SettingsService } from './settings.service';
import { UpsertDocumentTagDto } from './dto/upsert-document-tag.dto';
import { ReorderDocumentTagsDto } from './dto/reorder-document-tags.dto';

@ApiTags('Settings')
@ApiSecurity('api_key')
@UseGuards(ApiKeyGuard)
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  getSettings() {
    return this.settings.getSettings();
  }

  @Get('document-tags')
  getDocumentTags() {
    return this.settings.getDocumentTags();
  }

  @Post('document-tags')
  createDocumentTag(@Body() body: UpsertDocumentTagDto) {
    return this.settings.createDocumentTag(body);
  }

  @Patch('document-tags/order')
  reorderDocumentTags(@Body() body: ReorderDocumentTagsDto) {
    return this.settings.reorderDocumentTags(body.ids);
  }

  @Patch('document-tags/:id')
  updateDocumentTag(@Param('id') id: string, @Body() body: UpsertDocumentTagDto) {
    return this.settings.updateDocumentTag(id, body);
  }

  @Delete('document-tags/:id')
  hideDocumentTag(@Param('id') id: string) {
    return this.settings.hideDocumentTag(id);
  }
}
