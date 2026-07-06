import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiKeyGuard } from '../../common/auth/api-key.guard';
import { SettingsService } from './settings.service';

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
}
