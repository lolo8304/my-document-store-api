import { Controller, Get, NotFoundException, Query, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExtension, ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { timingSafeEqual } from 'crypto';
import { Request, Response } from 'express';
import { DropboxService } from '../documents/dropbox.service';

@ApiTags('Dropbox OAuth Setup')
@Controller('dropbox')
export class DropboxOauthController {
  constructor(
    private readonly config: ConfigService,
    private readonly dropbox: DropboxService,
  ) {}

  @Get('signin')
  @ApiOperation({ summary: 'Redirect to Dropbox OAuth setup' })
  @ApiHeader({
    name: 'operational-setup-key',
    required: true,
    description: 'Operational setup key required for Dropbox OAuth setup.',
  })
  @ApiExtension('x-operational-endpoint', true)
  @ApiExtension('x-operational-gate', 'Requires DROPBOX_OAUTH_SETUP_ENABLED=true.')
  dropboxSignIn(@Req() request: Request, @Res() response: Response) {
    this.assertDropboxOauthSetupEnabled(request);
    response.redirect(this.dropbox.oauth2AuthorizationUrl());
  }

  @Get('authorize')
  @ApiOperation({ summary: 'Exchange Dropbox OAuth authorization code' })
  @ApiHeader({
    name: 'operational-setup-key',
    required: true,
    description: 'Operational setup key required for Dropbox OAuth setup.',
  })
  @ApiQuery({
    name: 'code',
    required: true,
    description: 'Dropbox OAuth authorization code.',
  })
  @ApiExtension('x-operational-endpoint', true)
  @ApiExtension('x-operational-gate', 'Requires DROPBOX_OAUTH_SETUP_ENABLED=true.')
  async dropboxAuthorize(@Query('code') code: string, @Req() request: Request, @Res() response: Response) {
    this.assertDropboxOauthSetupEnabled(request);
    const data = await this.dropbox.authorizeAndUpdateToken(code);

    response.status(200).json({
      message:
        'Authorization successful. Copy the token values into .env, then set DROPBOX_OAUTH_SETUP_ENABLED=false.',
      data: {
        token_type: data.token_type,
        expires_in: data.expires_in,
        scope: data.scope,
        has_access_token: Boolean(data.access_token),
        has_refresh_token: Boolean(data.refresh_token),
        access_token: data.access_token,
        refresh_token: data.refresh_token,
      },
    });
  }

  private assertDropboxOauthSetupEnabled(request: Request): void {
    if (this.config.get<string>('DROPBOX_OAUTH_SETUP_ENABLED') !== 'true') {
      throw new NotFoundException('Dropbox OAuth setup is not enabled.');
    }
    this.assertOperationalSetupKey(request);
  }

  private assertOperationalSetupKey(request: Request): void {
    const expected = this.config.get<string>('OPERATIONAL_SETUP_KEY');
    const providedHeader = request.headers['operational-setup-key'];
    const provided = Array.isArray(providedHeader) ? providedHeader[0] : providedHeader;

    if (!expected || !provided) {
      throw new NotFoundException('Operational endpoint is not enabled.');
    }

    const expectedBuffer = Buffer.from(expected);
    const providedBuffer = Buffer.from(provided);
    if (expectedBuffer.length !== providedBuffer.length || !timingSafeEqual(expectedBuffer, providedBuffer)) {
      throw new NotFoundException('Operational endpoint is not enabled.');
    }
  }
}
