import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { BadRequestException } from '@nestjs/common';
import { DocumentsService, DOCUMENT_OCR_QUEUE } from './documents.service';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../s3/s3.service';
import { DocumentType, ProcessingStatus } from '@prisma/client';

describe('DocumentsService', () => {
  let service: DocumentsService;
  let prisma: PrismaService;
  let queue: any;

  const mockPrisma = {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    document: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    studentProfile: {
      findUnique: jest.fn(),
    },
  };

  const mockQueue = {
    add: jest.fn(),
  };

  const mockS3Service = {
    uploadFile: jest.fn(),
    getFileBuffer: jest.fn(),
    syncPendingLocalFiles: jest.fn().mockResolvedValue({ syncedCount: 0, errors: 0 }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: S3Service, useValue: mockS3Service },
        { provide: getQueueToken(DOCUMENT_OCR_QUEUE), useValue: mockQueue },
      ],
    }).compile();

    service = module.get<DocumentsService>(DocumentsService);
    prisma = module.get<PrismaService>(PrismaService);
    queue = module.get(getQueueToken(DOCUMENT_OCR_QUEUE));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should reject file upload if no file is provided', async () => {
    await expect(service.uploadDocument(null as any, 'student-101', DocumentType.PASSPORT)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('should reject file upload if file extension is disallowed', async () => {
    const mockFile: any = {
      originalname: 'malicious.exe',
      mimetype: 'application/x-msdownload',
      size: 1024,
      buffer: Buffer.from('MZ...'),
    };

    await expect(service.uploadDocument(mockFile, 'student-101', DocumentType.PASSPORT)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('should upload valid PDF document to S3 and enqueue BullMQ job', async () => {
    const pdfMagicBytes = Buffer.from('%PDF-1.4 sample content');
    const mockFile: any = {
      originalname: 'transcript.pdf',
      mimetype: 'application/pdf',
      size: pdfMagicBytes.length,
      buffer: pdfMagicBytes,
    };

    mockS3Service.uploadFile.mockResolvedValue({
      url: 'https://fairpath-documents.s3.us-east-1.amazonaws.com/documents/student-101/doc-uuid.pdf',
      s3Key: 'documents/student-101/doc-uuid.pdf',
      storedLocally: false,
    });

    mockPrisma.user.findUnique.mockResolvedValue({ id: 'student-101', email: 'student_1@fairpath.study' });
    mockPrisma.document.create.mockResolvedValue({
      id: 'doc-uuid-123',
      studentId: 'student-101',
      type: DocumentType.TRANSCRIPT,
      fileName: 'transcript.pdf',
      fileUrl: 'https://fairpath-documents.s3.us-east-1.amazonaws.com/documents/student-101/doc-uuid.pdf',
      status: ProcessingStatus.PENDING,
    });
    mockQueue.add.mockResolvedValue({ id: 'job-1' });

    const result = await service.uploadDocument(mockFile, 'student-101', DocumentType.TRANSCRIPT);

    expect(result).toBeDefined();
    expect(result.documentId).toBe('doc-uuid-123');
    expect(result.status).toBe(ProcessingStatus.PENDING);
    expect(mockS3Service.uploadFile).toHaveBeenCalled();
    expect(mockQueue.add).toHaveBeenCalledWith('process-ocr', expect.any(Object), expect.any(Object));
  });
});
