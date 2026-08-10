import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { DOCUMENT_OCR_QUEUE } from './documents.service.js';
import { OcrService } from '../ocr/ocr.service.js';
import { LlmExtractionService } from '../ocr/llm-extraction.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { S3Service } from '../s3/s3.service.js';
import { ProcessingStatus } from '@prisma/client';

export interface IDocumentJobPayload {
  documentId: string;
  s3Key?: string;
  filePath: string;
  mimeType: string;
  documentType: string;
  studentId: number;
}

@Processor(DOCUMENT_OCR_QUEUE)
export class DocumentOcrProcessor extends WorkerHost {
  private readonly logger = new Logger(DocumentOcrProcessor.name);

  constructor(
    private readonly ocrService: OcrService,
    private readonly llmExtractionService: LlmExtractionService,
    private readonly prisma: PrismaService,
    private readonly s3Service: S3Service,
  ) {
    super();
  }

  async process(job: Job<IDocumentJobPayload>): Promise<any> {
    const { documentId, s3Key, filePath, mimeType, documentType, studentId } = job.data;
    this.logger.log(`[Job ${job.id}] Starting OCR & LLM processing for Document ID: ${documentId}...`);

    // 1. Update Document status to PROCESSING
    await this.prisma.document.update({
      where: { id: documentId },
      data: { status: ProcessingStatus.PROCESSING },
    });

    try {
      // 2. Fetch document buffer from S3 (with local fallback support)
      const targetKey = s3Key || filePath;
      const fileBuffer = await this.s3Service.getFileBuffer(targetKey, filePath);

      // 3. Execute OCR Service (AWS Textract / Local Fallback)
      const ocrResult = await this.ocrService.processDocument(fileBuffer, mimeType);
      this.logger.log(`[Job ${job.id}] OCR completed using engine '${ocrResult.engine}'. Extracted ${ocrResult.rawText.length} characters.`);

      // 4. Execute LLM Extraction Service
      const extractedResult = await this.llmExtractionService.extractStructuredData(
        documentType,
        ocrResult.rawText,
      );

      // 5. Update Document status to COMPLETED
      await this.prisma.document.update({
        where: { id: documentId },
        data: {
          status: ProcessingStatus.COMPLETED,
          rawOcrText: ocrResult.rawText,
          extractedData: extractedResult.extractedFields,
        },
      });

      // 6. Merge & Update StudentProfile unified profile
      await this.updateStudentProfile(studentId, documentType, extractedResult.extractedFields);

      this.logger.log(`[Job ${job.id}] Successfully completed OCR & LLM extraction for Document ID: ${documentId}.`);
      return { success: true, documentId, extractedData: extractedResult.extractedFields };
    } catch (error: any) {
      this.logger.error(`[Job ${job.id}] Processing failed for Document ID ${documentId}: ${error.message}`, error.stack);

      await this.prisma.document.update({
        where: { id: documentId },
        data: {
          status: ProcessingStatus.FAILED,
          errorMessage: error.message,
        },
      });

      throw error;
    }
  }

  private async updateStudentProfile(
    studentId: number,
    documentType: string,
    extractedFields: Record<string, any>,
  ) {
    const existingProfile = await this.prisma.studentProfile.findUnique({
      where: { studentId },
    });

    let passportDetails = (existingProfile?.passportDetails as Record<string, any>) || {};
    let academicHistory = (existingProfile?.academicHistory as Record<string, any>) || {};
    let testScores = (existingProfile?.testScores as Record<string, any>) || {};

    if (documentType === 'PASSPORT') {
      passportDetails = { ...passportDetails, ...extractedFields };
    } else if (documentType === 'TRANSCRIPT') {
      academicHistory = { ...academicHistory, ...extractedFields };
    } else if (documentType === 'TEST_SCORE') {
      testScores = { ...testScores, ...extractedFields };
    }

    const unifiedProfile = {
      studentId,
      lastUpdated: new Date().toISOString(),
      passportDetails,
      academicHistory,
      testScores,
    };

    await this.prisma.studentProfile.upsert({
      where: { studentId },
      create: {
        studentId,
        passportDetails,
        academicHistory,
        testScores,
        unifiedProfile,
      },
      update: {
        passportDetails,
        academicHistory,
        testScores,
        unifiedProfile,
      },
    });
  }
}
