import {
  Controller,
  Post,
  Get,
  Param,
  UseInterceptors,
  UploadedFile,
  Body,
  BadRequestException,
  ParseIntPipe,
  DefaultValuePipe,
  Res,
  Logger,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiConsumes, ApiBody, ApiResponse } from '@nestjs/swagger';
import { DocumentsService } from './documents.service.js';
import { DocumentType } from '@prisma/client';

import type { Response } from 'express';

@ApiTags('Documents')
@Controller('documents')
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Post('upload')
  @ApiOperation({ summary: 'Upload a student document (transcript, passport, test score) for OCR & LLM processing' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        studentId: { type: 'number', example: 1 },
        documentType: {
          type: 'string',
          enum: ['TRANSCRIPT', 'PASSPORT', 'TEST_SCORE', 'OTHER'],
          example: 'PASSPORT',
        },
      },
      required: ['file', 'studentId'],
    },
  })
  @ApiResponse({ status: 201, description: 'File uploaded and queued for processing.' })
  @UseInterceptors(FileInterceptor('file'))
  async uploadDocument(
    @UploadedFile() file: Express.Multer.File,
    @Body('studentId', new DefaultValuePipe(1), ParseIntPipe) studentId: number,
    @Body('documentType') documentType: DocumentType,
  ) {
    Logger.log(`[Upload Request] File: ${file?.originalname || 'None'}, studentId: ${studentId}, type: ${documentType}`);
    if (!file) {
      throw new BadRequestException('A document file is required.');
    }
    return this.documentsService.uploadDocument(file, studentId, documentType);
  }

  @Get(':id/status')
  @ApiOperation({ summary: 'Get document status, raw OCR output, and extracted structured JSON data' })
  async getDocumentStatus(@Param('id') id: string) {
    return this.documentsService.getDocumentStatus(id);
  }

  @Get(':id/download')
  @ApiOperation({ summary: 'Securely view or download an uploaded document file' })
  async downloadDocument(@Param('id') id: string, @Res() res: Response) {
    const fileData = await this.documentsService.downloadDocument(id);
    res.setHeader('Content-Type', fileData.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${fileData.fileName}"`);
    return res.send(fileData.buffer);
  }

  @Get('list/:studentId')
  @ApiOperation({ summary: 'List all uploaded documents for a specific student' })
  async getStudentDocuments(@Param('studentId', ParseIntPipe) studentId: number) {
    return this.documentsService.getStudentDocuments(studentId);
  }

  @Get('profile/:studentId')
  @ApiOperation({ summary: 'Get consolidated unified JSON profile for a student' })
  async getStudentProfile(@Param('studentId', ParseIntPipe) studentId: number) {
    return this.documentsService.getStudentUnifiedProfile(studentId);
  }
}
