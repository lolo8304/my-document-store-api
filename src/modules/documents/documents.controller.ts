import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../../common/auth/api-key.guard';
import { SearchDocumentsDto } from './dto/search-documents.dto';
import { DocumentsService } from './documents.service';

@UseGuards(ApiKeyGuard)
@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get('search')
  search(@Query() query: SearchDocumentsDto) {
    return this.documents.search(query);
  }

  @Get('latest')
  latest(@Query('limit') limit?: string) {
    return this.documents.latest(limit);
  }

  @Get(':id')
  getDocument(@Param('id') id: string) {
    return this.documents.getDocument(id);
  }

  @Get(':id/text')
  getFullText(@Param('id') id: string) {
    return this.documents.getFullText(id);
  }

  @Get(':id/pdf-link')
  getPdfLink(@Param('id') id: string) {
    return this.documents.getPdfLink(id);
  }
}
