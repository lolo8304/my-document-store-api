import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server } from 'socket.io';

export interface SyncProgressEvent {
  running: boolean;
  current: number;
  total: number;
  imported: number;
  skipped: number;
  markedDeleted: number;
  failed: number;
  status: 'idle' | 'running' | 'stopping' | 'completed' | 'failed' | 'stopped';
  phase?: 'idle' | 'listing' | 'checking' | 'downloading' | 'extracting' | 'spellchecking' | 'embedding' | 'storing' | 'deleting';
  fileName?: string;
  fileElapsedSeconds?: number;
  stepCurrent?: number;
  stepTotal?: number;
  stepUnit?: 'page' | 'chunk';
  startedAt?: string;
  error?: string;
}

@WebSocketGateway({
  cors: {
    origin: process.env.APP_CORS_ORIGIN ?? 'http://localhost:3001',
  },
})
export class SyncProgressGateway {
  @WebSocketServer()
  private readonly server: Server;

  emitProgress(progress: SyncProgressEvent) {
    this.server.emit('sync.progress', progress);
  }
}
