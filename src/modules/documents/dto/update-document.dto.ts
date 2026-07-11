import { ArrayUnique, IsArray, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

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
}
