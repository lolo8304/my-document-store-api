import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';

export class SearchDocumentsDto {
  @IsString()
  @IsNotEmpty()
  q: string;

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
}
