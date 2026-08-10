import { Module } from '@nestjs/common';
import { OcrService } from './ocr.service.js';
import { LlmExtractionService } from './llm-extraction.service.js';

@Module({
  providers: [OcrService, LlmExtractionService],
  exports: [OcrService, LlmExtractionService],
})
export class OcrModule {}
