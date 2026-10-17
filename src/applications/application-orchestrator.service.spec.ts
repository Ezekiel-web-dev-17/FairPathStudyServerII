import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ApplicationOrchestratorService } from './application-orchestrator.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AUTO_APPLY_QUEUE } from './applications.dto.js';
import { ApplicationStatus, DocumentType, ProcessingStatus } from '@prisma/client';

describe('ApplicationOrchestratorService', () => {
  let service: ApplicationOrchestratorService;
  let prismaService: any;
  let eventEmitter: any;
  let autoApplyQueue: any;

  const mockPrismaService = {
    application: {
      findUnique: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
    },
  };

  const mockEventEmitter = {
    emit: jest.fn(),
  };

  const mockAutoApplyQueue = {
    add: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApplicationOrchestratorService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        {
          provide: EventEmitter2,
          useValue: mockEventEmitter,
        },
        {
          provide: getQueueToken(AUTO_APPLY_QUEUE),
          useValue: mockAutoApplyQueue,
        },
      ],
    }).compile();

    service = module.get<ApplicationOrchestratorService>(
      ApplicationOrchestratorService,
    );
    prismaService = module.get<PrismaService>(PrismaService);
    eventEmitter = module.get<EventEmitter2>(EventEmitter2);
    autoApplyQueue = module.get(getQueueToken(AUTO_APPLY_QUEUE));
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('processApplication()', () => {
    it('should throw NotFoundException if application does not exist', async () => {
      mockPrismaService.application.findUnique.mockResolvedValue(null);

      await expect(service.processApplication('non-existent-id')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should return NO_OP if application status is not GATHERING_DOCS', async () => {
      mockPrismaService.application.findUnique.mockResolvedValue({
        id: 'app-draft',
        status: ApplicationStatus.DRAFT,
        institution: { id: 'inst-1', name: 'MIT' },
        user: { id: 'usr-1', documents: [] },
        documents: [],
      });

      const result = await service.processApplication('app-draft');

      expect(result.actionTaken).toBe('NO_OP');
      expect(result.previousStatus).toBe(ApplicationStatus.DRAFT);
      expect(mockPrismaService.application.update).not.toHaveBeenCalled();
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
      expect(mockAutoApplyQueue.add).not.toHaveBeenCalled();
    });

    it('should change status to AWAITING_USER_INPUT and emit application.missing_docs when documents are missing', async () => {
      // User has only PASSPORT, but institution requires PASSPORT and TRANSCRIPT
      mockPrismaService.application.findUnique.mockResolvedValue({
        id: 'app-1',
        userId: 'usr-100',
        institutionId: 'inst-200',
        status: ApplicationStatus.GATHERING_DOCS,
        institution: {
          id: 'inst-200',
          name: 'University of Oxford',
          metadata: {
            requiredDocuments: ['PASSPORT', 'TRANSCRIPT'],
          },
        },
        user: {
          id: 'usr-100',
          documents: [
            {
              id: 'doc-1',
              type: DocumentType.PASSPORT,
              status: ProcessingStatus.COMPLETED,
              fileUrl: 'https://s3.amazonaws.com/fairpath/passport.pdf',
            },
          ],
        },
        documents: [],
      });

      mockPrismaService.application.update.mockResolvedValue({
        id: 'app-1',
        status: ApplicationStatus.AWAITING_USER_INPUT,
      });

      const result = await service.processApplication('app-1');

      expect(result.actionTaken).toBe('AWAITING_USER_INPUT_EMITTED');
      expect(result.newStatus).toBe(ApplicationStatus.AWAITING_USER_INPUT);
      expect(result.missingDocuments).toEqual(['TRANSCRIPT']);

      // 1. Check DB update
      expect(mockPrismaService.application.update).toHaveBeenCalledWith({
        where: { id: 'app-1' },
        data: { status: ApplicationStatus.AWAITING_USER_INPUT },
      });

      // 2. Check Event emitted
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'application.missing_docs',
        expect.objectContaining({
          applicationId: 'app-1',
          userId: 'usr-100',
          institutionId: 'inst-200',
          missingDocuments: ['TRANSCRIPT'],
          uploadedDocuments: ['PASSPORT'],
        }),
      );

      // 3. Queue should NOT be pushed
      expect(mockAutoApplyQueue.add).not.toHaveBeenCalled();
    });

    it('should change status to PROCESSING_AUTO_SUBMIT and push job to auto-apply queue when all documents are present', async () => {
      // User has both PASSPORT and TRANSCRIPT
      mockPrismaService.application.findUnique.mockResolvedValue({
        id: 'app-2',
        userId: 'usr-101',
        institutionId: 'inst-201',
        status: ApplicationStatus.GATHERING_DOCS,
        institution: {
          id: 'inst-201',
          name: 'Harvard University',
          metadata: {
            requiredDocuments: ['PASSPORT', 'TRANSCRIPT'],
          },
        },
        user: {
          id: 'usr-101',
          documents: [
            {
              id: 'doc-1',
              type: DocumentType.PASSPORT,
              status: ProcessingStatus.COMPLETED,
              fileUrl: 'https://s3.amazonaws.com/fairpath/passport.pdf',
            },
            {
              id: 'doc-2',
              type: DocumentType.TRANSCRIPT,
              status: ProcessingStatus.COMPLETED,
              fileUrl: 'https://s3.amazonaws.com/fairpath/transcript.pdf',
            },
          ],
        },
        documents: [],
      });

      mockPrismaService.application.update.mockResolvedValue({
        id: 'app-2',
        status: ApplicationStatus.PROCESSING_AUTO_SUBMIT,
      });

      mockAutoApplyQueue.add.mockResolvedValue({ id: 'job-999' });

      const result = await service.processApplication('app-2');

      expect(result.actionTaken).toBe('PUSHED_TO_AUTO_APPLY_QUEUE');
      expect(result.newStatus).toBe(ApplicationStatus.PROCESSING_AUTO_SUBMIT);
      expect(result.missingDocuments).toEqual([]);
      expect(result.jobId).toBe('job-999');

      // 1. Check DB update
      expect(mockPrismaService.application.update).toHaveBeenCalledWith({
        where: { id: 'app-2' },
        data: { status: ApplicationStatus.PROCESSING_AUTO_SUBMIT },
      });

      // 2. Check Queue job added
      expect(mockAutoApplyQueue.add).toHaveBeenCalledWith(
        'auto-apply-submission',
        {
          applicationId: 'app-2',
          userId: 'usr-101',
          institutionId: 'inst-201',
        },
        expect.objectContaining({
          attempts: 3,
        }),
      );

      // 3. Event should NOT be emitted
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('should fallback to default baseline documents (PASSPORT, TRANSCRIPT) when institution metadata is empty', async () => {
      mockPrismaService.application.findUnique.mockResolvedValue({
        id: 'app-3',
        userId: 'usr-102',
        institutionId: 'inst-202',
        status: ApplicationStatus.GATHERING_DOCS,
        institution: {
          id: 'inst-202',
          name: 'Generic University',
          metadata: null, // Empty metadata
        },
        user: {
          id: 'usr-102',
          documents: [],
        },
        documents: [],
      });

      mockPrismaService.application.update.mockResolvedValue({
        id: 'app-3',
        status: ApplicationStatus.AWAITING_USER_INPUT,
      });

      const result = await service.processApplication('app-3');

      expect(result.requiredDocuments).toEqual([
        DocumentType.PASSPORT,
        DocumentType.TRANSCRIPT,
      ]);
      expect(result.missingDocuments).toEqual([
        DocumentType.PASSPORT,
        DocumentType.TRANSCRIPT,
      ]);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'application.missing_docs',
        expect.objectContaining({
          missingDocuments: [DocumentType.PASSPORT, DocumentType.TRANSCRIPT],
        }),
      );
    });
  });

  describe('getBlockedApplications()', () => {
    it('should query Prisma with SUBMISSION_FAILED_ADMIN_REVIEW filter, pagination, and projection', async () => {
      const mockBlockedItems = [
        {
          id: 'app-blocked-1',
          status: ApplicationStatus.SUBMISSION_FAILED_ADMIN_REVIEW,
          programName: 'MSc Data Science',
          term: 'Fall 2026',
          submittedAt: null,
          createdAt: new Date('2026-10-15T10:00:00Z'),
          updatedAt: new Date('2026-10-16T12:00:00Z'),
          submissionLogs: { failureReason: 'Portal captcha challenge encountered' },
          user: {
            id: 'usr-1',
            name: 'John Doe',
            email: 'john@example.com',
          },
          institution: {
            id: 'inst-1',
            name: 'Imperial College London',
            code: 'IMP',
            country: 'GB',
          },
        },
      ];

      mockPrismaService.application.count.mockResolvedValue(45);
      mockPrismaService.application.findMany.mockResolvedValue(mockBlockedItems);

      const result = await service.getBlockedApplications(2, 10);

      // Verify Prisma count call
      expect(mockPrismaService.application.count).toHaveBeenCalledWith({
        where: { status: ApplicationStatus.SUBMISSION_FAILED_ADMIN_REVIEW },
      });

      // Verify Prisma findMany query with pagination and projection
      expect(mockPrismaService.application.findMany).toHaveBeenCalledWith({
        where: { status: ApplicationStatus.SUBMISSION_FAILED_ADMIN_REVIEW },
        skip: 10,
        take: 10,
        orderBy: { updatedAt: 'desc' },
        select: expect.objectContaining({
          id: true,
          status: true,
          user: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          institution: {
            select: {
              id: true,
              name: true,
              code: true,
              country: true,
            },
          },
        }),
      });

      // Verify pagination calculation
      expect(result.pagination).toEqual({
        totalRecords: 45,
        page: 2,
        limit: 10,
        totalPages: 5,
        hasNextPage: true,
        hasPreviousPage: true,
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].user.name).toBe('John Doe');
      expect(result.data[0].institution.name).toBe('Imperial College London');
    });

    it('should clamp invalid page and limit values to safe bounds', async () => {
      mockPrismaService.application.count.mockResolvedValue(0);
      mockPrismaService.application.findMany.mockResolvedValue([]);

      const result = await service.getBlockedApplications(-5, 500);

      expect(result.pagination.page).toBe(1);
      expect(result.pagination.limit).toBe(100); // Clamped to 100 max
      expect(mockPrismaService.application.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 0,
          take: 100,
        }),
      );
    });
  });
});

