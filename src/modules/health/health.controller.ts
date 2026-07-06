import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  getHealth() {
    return {
      status: 'ok',
      service: 'my-document-store-api',
      timestamp: new Date().toISOString(),
    };
  }
}
