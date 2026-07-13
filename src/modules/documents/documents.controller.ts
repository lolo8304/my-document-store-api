import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../../common/auth/api-key.guard';
import { SearchDocumentsDto } from './dto/search-documents.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
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
  latest(
    @Query('limit') limit?: string,
    @Query('tags') tags?: string,
    @Query('tagMode') tagMode?: 'or' | 'and',
    @Query('sortBy') sortBy?: 'sent' | 'scanned',
    @Query('missingSent') missingSent?: string,
  ) {
    return this.documents.latest(limit, tags, tagMode, sortBy, missingSent === 'true');
  }

  @Get(':id')
  getDocument(@Param('id') id: string) {
    return this.documents.getDocument(id);
  }

  @Patch(':id')
  updateDocument(@Param('id') id: string, @Body() body: UpdateDocumentDto) {
    return this.documents.updateDocument(id, body);
  }

  @Post(':id/reprocess-ocr')
  reprocessOcr(@Param('id') id: string) {
    return this.documents.reprocessDocumentOcr(id);
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
