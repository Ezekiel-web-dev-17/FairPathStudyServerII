import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { AdminApplicationsController } from './admin-applications.controller.js';
import { ApplicationOrchestratorService } from './application-orchestrator.service.js';
import { ApplicationStatus } from '@prisma/client';

describe('AdminApplicationsController', () => {
  let controller: AdminApplicationsController;
  let orchestratorService: any;

  const mockOrchestratorService = {
    getBlockedApplications: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminApplicationsController],
      providers: [
        {
          provide: ApplicationOrchestratorService,
          useValue: mockOrchestratorService,
        },
      ],
    }).compile();

    controller = module.get<AdminApplicationsController>(
      AdminApplicationsController,
    );
    orchestratorService = module.get<ApplicationOrchestratorService>(
      ApplicationOrchestratorService,
    );
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('GET /admin/applications/blocked', () => {
    it('should validate query and return paginated blocked applications', async () => {
      const mockResponse = {
        data: [
          {
            id: 'app-blocked-1',
            status: ApplicationStatus.SUBMISSION_FAILED_ADMIN_REVIEW,
            programName: 'BSc Computer Science',
            term: 'Fall 2026',
            submittedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            submissionLogs: { error: 'Form input missing postal code' },
            user: {
              id: 'usr-1',
              name: 'Alice Johnson',
              email: 'alice@example.com',
            },
            institution: {
              id: 'inst-1',
              name: 'University of Edinburgh',
              code: 'EDIN',
              country: 'GB',
            },
          },
        ],
        pagination: {
          totalRecords: 1,
          page: 1,
          limit: 20,
          totalPages: 1,
          hasNextPage: false,
          hasPreviousPage: false,
        },
      };

      mockOrchestratorService.getBlockedApplications.mockResolvedValue(
        mockResponse,
      );

      const result = await controller.getBlockedApplications({
        page: 1,
        limit: 20,
      });

      expect(orchestratorService.getBlockedApplications).toHaveBeenCalledWith(
        1,
        20,
      );
      expect(result).toEqual(mockResponse);
      expect(result.data[0].user.name).toBe('Alice Johnson');
      expect(result.data[0].institution.name).toBe('University of Edinburgh');
    });

    it('should reject invalid page parameter with BadRequestException', async () => {
      await expect(
        controller.getBlockedApplications({ page: 0, limit: 20 } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject limit exceeding 100 with BadRequestException', async () => {
      await expect(
        controller.getBlockedApplications({ page: 1, limit: 250 } as any),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
