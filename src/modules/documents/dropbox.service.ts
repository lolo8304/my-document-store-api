import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Dropbox, files } from 'dropbox';

export interface DropboxPdfFile {
  id: string;
  name: string;
  pathLower: string;
  pathDisplay: string;
  contentHash: string;
  clientModified?: Date;
  serverModified?: Date;
}

@Injectable()
export class DropboxService {
  private readonly logger = new Logger(DropboxService.name);
  private client: Dropbox;
  private readonly sourceFolder: string;
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly redirectUri?: string;
  private accessToken?: string;
  private readonly refreshToken?: string;
  private expirationTime: Date;

  constructor(private readonly config: ConfigService) {
    this.clientId = this.config.get<string>('DROPBOX_CLIENT_ID');
    this.clientSecret = this.config.get<string>('DROPBOX_CLIENT_SECRET');
    this.redirectUri = this.config.get<string>('DROPBOX_REDIRECT_URL');
    this.refreshToken = this.config.get<string>('DROPBOX_REFRESH_TOKEN');
    this.updateAccessToken(this.config.get<string>('DROPBOX_ACCESS_TOKEN'), -1);
    this.sourceFolder = this.config.get<string>('DROPBOX_SOURCE_FOLDER') ?? '/From_BrotherDevice';
  }

  async listSourcePdfs(): Promise<DropboxPdfFile[]> {
    await this.refreshTokenIfNeeded();
    const entries = await this.listFolder(this.sourceFolder);
    return entries
      .filter((entry): entry is files.FileMetadataReference => this.isPdfFile(entry))
      .map((entry) => this.toPdfFile(entry));
  }

  async download(path: string): Promise<Buffer> {
    await this.refreshTokenIfNeeded();
    const response = await this.client.filesDownload({ path });
    const result = response.result as files.FileMetadata & { fileBinary?: Buffer; fileBlob?: Blob };
    if (result.fileBinary) {
      return Buffer.from(result.fileBinary);
    }
    if (result.fileBlob) {
      return Buffer.from(await result.fileBlob.arrayBuffer());
    }
    throw new Error(`Dropbox download returned no file payload for ${path}`);
  }

  async getDirectDownloadLink(path: string): Promise<string> {
    await this.refreshTokenIfNeeded();
    const existing = await this.client.sharingListSharedLinks({ path, direct_only: true });
    const link = existing.result.links[0] ?? (await this.createSharedLink(path));
    return this.toDirectDropboxUrl(link.url);
  }

  oauth2AuthorizationUrl(): string {
    if (!this.clientId || !this.redirectUri) {
      throw new BadRequestException('DROPBOX_CLIENT_ID and DROPBOX_REDIRECT_URL are required for Dropbox OAuth setup');
    }

    return (
      'https://www.dropbox.com/oauth2/authorize?' +
      new URLSearchParams({
        response_type: 'code',
        client_id: this.clientId,
        redirect_uri: this.redirectUri,
        token_access_type: 'offline',
      }).toString()
    );
  }

  async authorizeAndUpdateToken(code: string): Promise<{
    token_type?: string;
    expires_in?: number;
    scope?: string;
    access_token?: string;
    refresh_token?: string;
  }> {
    if (!this.clientId || !this.clientSecret || !this.redirectUri) {
      throw new BadRequestException(
        'DROPBOX_CLIENT_ID, DROPBOX_CLIENT_SECRET, and DROPBOX_REDIRECT_URL are required for Dropbox OAuth setup',
      );
    }

    const response = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        code,
        grant_type: 'authorization_code',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: this.redirectUri,
      }),
    });

    const data = (await response.json()) as {
      token_type?: string;
      expires_in?: number;
      scope?: string;
      access_token?: string;
      refresh_token?: string;
      error_description?: string;
    };

    if (!response.ok || !data.access_token) {
      throw new BadRequestException(
        `Failed to run Dropbox authorization_code grant flow: ${data.error_description ?? response.statusText}`,
      );
    }

    return data;
  }

  async getDiagnostics() {
    await this.refreshTokenIfNeeded();

    const [account, root, source, sharedFolders] = await Promise.all([
      this.captureDropboxCall(() => this.client.usersGetCurrentAccount()),
      this.captureDropboxCall(() => this.client.filesListFolder({ path: '', recursive: false, limit: 25 })),
      this.captureDropboxCall(() => this.client.filesListFolder({ path: this.sourceFolder, recursive: false, limit: 25 })),
      this.captureDropboxCall(() => this.client.sharingListFolders({ limit: 100 })),
    ]);

    return {
      configuredPaths: {
        sourceFolder: this.sourceFolder,
      },
      account: account.ok
        ? {
            email: account.value.result.email,
            rootInfo: account.value.result.root_info,
          }
        : account,
      root: root.ok ? this.summarizeListFolder(root.value.result.entries) : root,
      sourceFolder: source.ok ? this.summarizeListFolder(source.value.result.entries) : source,
      sharedFolders: sharedFolders.ok
        ? sharedFolders.value.result.entries.map((entry) => ({
            name: entry.name,
            pathLower: entry.path_lower,
            sharedFolderId: entry.shared_folder_id,
            accessType: entry.access_type,
          }))
        : sharedFolders,
    };
  }

  private async createSharedLink(path: string): Promise<{ url: string }> {
    await this.refreshTokenIfNeeded();
    const response = await this.client.sharingCreateSharedLinkWithSettings({ path });
    return response.result;
  }

  private isTokenExpired(): boolean {
    return new Date() > this.expirationTime;
  }

  private async refreshTokenIfNeeded(): Promise<void> {
    if (!this.refreshToken) {
      if (!this.accessToken) {
        throw new Error('DROPBOX_ACCESS_TOKEN or DROPBOX_REFRESH_TOKEN must be configured');
      }
      return;
    }

    if (this.isTokenExpired()) {
      await this.refreshAndUpdateToken();
    }
  }

  private async refreshAndUpdateToken(): Promise<void> {
    if (!this.refreshToken || !this.clientId || !this.clientSecret) {
      throw new Error('DROPBOX_CLIENT_ID, DROPBOX_CLIENT_SECRET, and DROPBOX_REFRESH_TOKEN are required for token refresh');
    }

    const response = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });

    const data = (await response.json()) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!response.ok || !data.access_token) {
      throw new Error(`Failed to refresh Dropbox token: ${data.error_description ?? response.statusText}`);
    }

    this.updateAccessToken(data.access_token, data.expires_in ?? 14400);
  }

  private updateAccessToken(accessToken: string | undefined, ttlInSeconds: number): void {
    this.accessToken = accessToken;
    this.expirationTime = new Date(Date.now() + ttlInSeconds * 1000);
    this.client = new Dropbox({ accessToken: this.accessToken });
  }

  private toDirectDropboxUrl(url: string): string {
    const parsed = new URL(url);
    parsed.searchParams.delete('dl');
    parsed.searchParams.set('raw', '1');
    return parsed.toString();
  }

  private async listFolder(path: string): Promise<files.MetadataReference[]> {
    try {
      const first = await this.client.filesListFolder({ path, recursive: false });
      const entries = [...first.result.entries];
      let cursor = first.result.cursor;
      let hasMore = first.result.has_more;

      while (hasMore) {
        const next = await this.client.filesListFolderContinue({ cursor });
        entries.push(...next.result.entries);
        cursor = next.result.cursor;
        hasMore = next.result.has_more;
      }

      return entries;
    } catch (error) {
      this.logger.error(`Could not list Dropbox folder ${path}: ${this.dropboxErrorMessage(error)}`);
      throw error;
    }
  }

  private async captureDropboxCall<T>(call: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
    try {
      return { ok: true, value: await call() };
    } catch (error) {
      return { ok: false, error: this.dropboxErrorMessage(error) };
    }
  }

  private summarizeListFolder(entries: files.MetadataReference[]) {
    return entries.map((entry) => ({
      type: entry['.tag'],
      name: entry.name,
      pathDisplay: entry.path_display,
      id: 'id' in entry ? entry.id : undefined,
    }));
  }

  private dropboxErrorMessage(error: unknown): string {
    const candidate = error as { status?: number; error?: unknown; message?: string };
    const status = candidate.status ? `status=${candidate.status} ` : '';
    const detail = typeof candidate.error === 'string' ? candidate.error : JSON.stringify(candidate.error ?? candidate.message ?? error);
    return `${status}${detail}`;
  }

  private isPdfFile(entry: files.MetadataReference): entry is files.FileMetadataReference {
    return entry['.tag'] === 'file' && entry.name.toLowerCase().endsWith('.pdf');
  }

  private toPdfFile(entry: files.FileMetadataReference): DropboxPdfFile {
    return {
      id: entry.id,
      name: entry.name,
      pathLower: entry.path_lower ?? entry.path_display ?? entry.name,
      pathDisplay: entry.path_display ?? entry.path_lower ?? entry.name,
      contentHash: entry.content_hash ?? '',
      clientModified: entry.client_modified ? new Date(entry.client_modified) : undefined,
      serverModified: entry.server_modified ? new Date(entry.server_modified) : undefined,
    };
  }
}
