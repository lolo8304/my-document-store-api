import { Transform, Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class SearchDocumentsDto {
  @IsOptional()
  @IsString()
  q = '';

  @IsIn(['query', 'question'])
  type: 'query' | 'question' = 'query';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  includeDeleted = false;

  @IsOptional()
  @Transform(({ value }) => {
    if (Array.isArray(value)) {
      return value;
    }
    if (typeof value === 'string') {
      return value.split(',').map((tag) => tag.trim()).filter(Boolean);
    }
    return [];
  })
  @IsArray()
  tags: string[] = [];

  @IsOptional()
  @IsIn(['or', 'and'])
  tagMode: 'or' | 'and' = 'or';

  @IsOptional()
  @IsIn(['sent', 'scanned'])
  sortBy?: 'sent' | 'scanned';

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  missingSent = false;
}
