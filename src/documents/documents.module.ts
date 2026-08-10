import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService, DOCUMENT_OCR_QUEUE } from './documents.service.js';
import { DocumentOcrProcessor } from './document-ocr.processor.js';
import { OcrModule } from '../ocr/ocr.module.js';
import { S3Module } from '../s3/s3.module.js';

@Module({
  imports: [
    BullModule.registerQueue({
      name: DOCUMENT_OCR_QUEUE,
    }),
    OcrModule,
    S3Module,
  ],
  controllers: [DocumentsController],
  providers: [DocumentsService, DocumentOcrProcessor],
  exports: [DocumentsService],
})
export class DocumentsModule {}
