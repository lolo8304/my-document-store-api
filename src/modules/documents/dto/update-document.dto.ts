import { ArrayUnique, IsArray, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class UpdateDocumentDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  tags?: string[];

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  sentAt?: string | null;
}
