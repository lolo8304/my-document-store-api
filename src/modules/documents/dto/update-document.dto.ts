import { ArrayUnique, IsArray, IsBoolean, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

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

  @IsOptional()
  @IsBoolean()
  clearMetadata?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  sender?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  recipient?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  sentLocation?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  subject?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  referenceNumber?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  invoiceNumber?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  customerNumber?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  accountNumber?: string | null;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  deadlineAt?: string | null;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  paymentDueAt?: string | null;
}
