import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class SettingsService {
  constructor(private readonly config: ConfigService) {}

  getSettings() {
    return {
      features: {
        vectorSearchEnabled: this.config.get<string>('VECTOR_SEARCH_ENABLED') === 'true',
      },
    };
  }
}
