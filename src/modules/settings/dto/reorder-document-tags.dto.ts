import { IsArray, IsString } from 'class-validator';

export class ReorderDocumentTagsDto {
  @IsArray()
  @IsString({ each: true })
  ids: string[];
}
