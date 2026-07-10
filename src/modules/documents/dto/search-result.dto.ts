export interface SearchResultItem {
  documentId: string;
  title: string;
  fileName: string;
  language?: string;
  createdAt?: string;
  modifiedAt?: string;
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
