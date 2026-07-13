export interface SearchResultItem {
  documentId: string;
  title: string;
  fileName: string;
  tags: string[];
  language?: string;
  createdAt?: string;
  modifiedAt?: string;
  sentAt?: string;
  hasSentDate: boolean;
  sender?: string;
  recipient?: string;
  subject?: string;
  referenceNumber?: string;
  invoiceNumber?: string;
  customerNumber?: string;
  accountNumber?: string;
  deadlineAt?: string;
  paymentDueAt?: string;
  excerpt: string;
  matchedTerms: string[];
  textUrl: string;
  pdfUrl?: string;
  score?: number;
}

export interface SearchResultDto {
  items: SearchResultItem[];
  page: number;
  pageSize: number;
  total: number;
}
