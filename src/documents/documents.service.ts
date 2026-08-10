import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import * as path from 'path';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { S3Service } from '../s3/s3.service.js';
import { DocumentType, ProcessingStatus } from '@prisma/client';

export const DOCUMENT_OCR_QUEUE = 'document-ocr-queue';

export interface IDocumentUploadResult {
  documentId: string;
  fileName: string;
  status: ProcessingStatus;
  message: string;
  fileUrl: string;
  s3Key: string;
}

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly s3Service: S3Service,
    @InjectQueue(DOCUMENT_OCR_QUEUE) private readonly ocrQueue: Queue,
  ) {}

  async uploadDocument(
    file: Express.Multer.File,
    studentId: number,
    documentType: DocumentType,
  ): Promise<IDocumentUploadResult> {
    if (!file) {
      throw new BadRequestException('No file provided for upload.');
    }

    // 1. File size enforcement (Max 10MB)
    const MAX_SIZE = 10 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
      throw new BadRequestException('File size exceeds maximum permitted limit (10MB).');
    }

    // 2. File extension & MIME type allow-list validation
    const allowedExtensions = ['.pdf', '.png', '.jpg', '.jpeg'];
    const sanitizeOriginalName = path.basename(file.originalname);
    const ext = path.extname(sanitizeOriginalName).toLowerCase();

    if (!allowedExtensions.includes(ext)) {
      throw new BadRequestException(`Invalid file extension '${ext}'. Allowed extensions: ${allowedExtensions.join(', ')}`);
    }

    const allowedMimeTypes = ['application/pdf', 'image/png', 'image/jpeg'];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      throw new BadRequestException(`Invalid MIME type '${file.mimetype}'.`);
    }

    // 3. Inspect magic bytes header for safety
    this.validateMagicBytes(file.buffer, ext);

    // 4. Ensure target user exists (or create demo user)
    await this.ensureUserExists(studentId);

    // 5. Generate S3 object key
    const s3Key = `documents/${studentId}/${crypto.randomUUID()}${ext}`;

    // 6. Upload document buffer to AWS S3 (with local fallback resilience)
    const uploadResult = await this.s3Service.uploadFile(file.buffer, s3Key, file.mimetype);

    // 7. Save document record to Database
    const documentRecord = await this.prisma.document.create({
      data: {
        studentId,
        type: documentType || DocumentType.OTHER,
        fileName: sanitizeOriginalName,
        fileUrl: uploadResult.url,
        mimeType: file.mimetype,
        fileSize: file.size,
        status: ProcessingStatus.PENDING,
      },
    });

    // 8. Enqueue background job to BullMQ
    await this.ocrQueue.add(
      'process-ocr',
      {
        documentId: documentRecord.id,
        s3Key: uploadResult.s3Key,
        filePath: uploadResult.url,
        mimeType: file.mimetype,
        documentType: documentRecord.type,
        studentId,
      },
      {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
      },
    );

    this.logger.log(`Document [ID: ${documentRecord.id}] stored (${uploadResult.storedLocally ? 'Local Fallback' : 'AWS S3'}) and enqueued for OCR processing.`);

    // Check & trigger background sync if local fallback files exist
    this.s3Service.syncPendingLocalFiles().catch((err) => {
      this.logger.error(`Error during background S3 sync check: ${err.message}`);
    });

    return {
      documentId: documentRecord.id,
      fileName: sanitizeOriginalName,
      status: documentRecord.status,
      message: uploadResult.storedLocally
        ? 'Document saved to local fallback storage (S3 unreachable/unconfigured) and queued for OCR processing.'
        : 'Document successfully uploaded to AWS S3 and queued for OCR processing.',
      fileUrl: uploadResult.url,
      s3Key: uploadResult.s3Key,
    };
  }

  async getDocumentStatus(documentId: string) {
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
    });
    if (!doc) {
      throw new NotFoundException(`Document with ID '${documentId}' not found.`);
    }
    return doc;
  }

  async downloadDocument(documentId: string) {
    const doc = await this.getDocumentStatus(documentId);
    const buffer = await this.s3Service.getFileBuffer(doc.fileUrl);
    return {
      buffer,
      mimeType: doc.mimeType,
      fileName: doc.fileName,
    };
  }

  async getStudentDocuments(studentId: number) {
    return this.prisma.document.findMany({
      where: { studentId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getStudentUnifiedProfile(studentId: number) {
    const profile = await this.prisma.studentProfile.findUnique({
      where: { studentId },
      include: { student: { select: { id: true, email: true, name: true } } },
    });
    if (!profile) {
      throw new NotFoundException(`Profile for student ID '${studentId}' not found.`);
    }
    return profile;
  }

  private validateMagicBytes(buffer: Buffer, ext: string) {
    if (buffer.length < 4) {
      throw new BadRequestException('Uploaded file is corrupted or empty.');
    }

    const headerHex = buffer.slice(0, 4).toString('hex').toUpperCase();

    if (ext === '.pdf' && !headerHex.startsWith('25504446')) { // %PDF
      throw new BadRequestException('File header does not match a valid PDF document.');
    }
    if (ext === '.png' && !headerHex.startsWith('89504E47')) { // PNG header
      throw new BadRequestException('File header does not match a valid PNG image.');
    }
    if ((ext === '.jpg' || ext === '.jpeg') && !headerHex.startsWith('FFD8FF')) { // JPEG header
      throw new BadRequestException('File header does not match a valid JPEG image.');
    }
  }

  private async ensureUserExists(studentId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: studentId },
    });
    if (!user) {
      await this.prisma.user.create({
        data: {
          id: studentId,
          email: `student_${studentId}@fairpath.study`,
          name: `Student #${studentId}`,
        },
      });
    }
  }
}
