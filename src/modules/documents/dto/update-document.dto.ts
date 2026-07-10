import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class UpdateDocumentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title: string;
}
