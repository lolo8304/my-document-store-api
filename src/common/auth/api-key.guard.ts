import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const configuredKey =
      this.config.get<string>('MY_DOCUMENT_STORE_API_KEY') ??
      this.config.get<string>('my-document-store-key');

    if (!configuredKey) {
      throw new UnauthorizedException('API key is not configured');
    }

    const providedKey = request.header('api_key');
    if (providedKey !== configuredKey) {
      throw new UnauthorizedException('Invalid API key');
    }

    return true;
  }
}
