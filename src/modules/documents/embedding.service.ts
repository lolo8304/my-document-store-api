import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

@Injectable()
export class EmbeddingService {
  private readonly client?: OpenAI;
  private readonly model: string;

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    this.client = this.isVectorSearchEnabled() && apiKey ? new OpenAI({ apiKey }) : undefined;
    this.model = this.config.get<string>('OPENAI_EMBEDDING_MODEL') ?? 'text-embedding-3-small';
  }

  async embed(input: string): Promise<number[]> {
    if (!this.client) {
      throw new Error('OPENAI_API_KEY is required for vector search');
    }
    const response = await this.client.embeddings.create({
      model: this.model,
      input,
    });
    return response.data[0].embedding;
  }

  async embedMany(inputs: string[]): Promise<number[][]> {
    if (inputs.length === 0) {
      return [];
    }
    if (!this.client) {
      throw new Error('OPENAI_API_KEY is required for vector search');
    }
    const response = await this.client.embeddings.create({
      model: this.model,
      input: inputs,
    });
    return response.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
  }

  private isVectorSearchEnabled(): boolean {
    return this.config.get<string>('VECTOR_SEARCH_ENABLED') === 'true';
  }
}
