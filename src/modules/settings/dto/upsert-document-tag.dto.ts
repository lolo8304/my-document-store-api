import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpsertDocumentTagDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(3)
  short: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  text: string;

  @IsOptional()
  @IsString()
  id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  icon?: string;
}
