import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { NotificationsService } from './notifications.service.js';
import { NOTIFICATIONS_QUEUE, NotificationsProcessor } from './notifications.processor.js';
import { ResendService } from './resend.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { NotificationStatus, NotificationType } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';

describe('NotificationsService & Processor', () => {
  let service: NotificationsService;
  let processor: NotificationsProcessor;
  let mockQueue: { add: jest.Mock };
  let mockConfigService: { get: jest.Mock };
  let mockResendService: {
    sendEmail: jest.Mock;
    renderHtmlTemplate: jest.Mock;
  };
  let mockPrisma: {
    user: { findUnique: jest.Mock };
    notification: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      count: jest.Mock;
      update: jest.Mock;
    };
  };

  const mockUser = {
    id: 'student-uuid-1',
    email: 'applicant@example.com',
    name: 'John Doe',
  };

  beforeEach(async () => {
    mockQueue = {
      add: jest.fn().mockResolvedValue({ id: 'job-999' }),
    };

    mockConfigService = {
      get: jest.fn().mockReturnValue('admin@fairpath.study'),
    };

    mockResendService = {
      sendEmail: jest.fn().mockResolvedValue({ id: 're_test123', isMock: true }),
      renderHtmlTemplate: jest.fn().mockReturnValue('<html>Test Template</html>'),
    };

    mockPrisma = {
      user: {
        findUnique: jest.fn(),
      },
      notification: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        NotificationsProcessor,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
        {
          provide: ResendService,
          useValue: mockResendService,
        },
        {
          provide: PrismaService,
          useValue: mockPrisma,
        },
        {
          provide: getQueueToken(NOTIFICATIONS_QUEUE),
          useValue: mockQueue,
        },
      ],
    }).compile();

    service = module.get<NotificationsService>(NotificationsService);
    processor = module.get<NotificationsProcessor>(NotificationsProcessor);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
    expect(processor).toBeDefined();
  });

  describe('queueMissingFieldsNotification', () => {
    it('should throw NotFoundException if student is not found', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.queueMissingFieldsNotification({
          studentId: 'non-existent',
          applicationTitle: 'Computer Science MSc',
          missingFields: [],
          suggestedDocuments: [],
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should create admin and user notifications and enqueue both email jobs', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);

      const adminMock = {
        id: 'admin-notif-1',
        recipient: 'admin@fairpath.study',
        type: NotificationType.ADMIN_ACTION_REQUIRED,
        status: NotificationStatus.PENDING,
      };
      const userMock = {
        id: 'user-notif-1',
        recipient: mockUser.email,
        type: NotificationType.USER_EMAIL_REQUEST,
        status: NotificationStatus.PENDING,
      };

      mockPrisma.notification.create
        .mockResolvedValueOnce(adminMock)
        .mockResolvedValueOnce(userMock);

      const result = await service.queueMissingFieldsNotification({
        studentId: mockUser.id,
        applicationTitle: 'Computer Science MSc',
        portalUrl: 'https://university.edu/apply',
        missingFields: [
          { id: 'f1', name: 'sop', label: 'Statement of Purpose', type: 'textarea' },
        ],
        suggestedDocuments: ['Official Transcript'],
        customMessage: 'Please submit before Friday deadline',
      });

      expect(mockPrisma.notification.create).toHaveBeenCalledTimes(2);
      expect(mockQueue.add).toHaveBeenCalledTimes(2);
      expect(result.userJobId).toBe('job-999');
      expect(result.adminJobId).toBe('job-999');
    });
  });

  describe('handleResendWebhookEvent', () => {
    it('should update status to OPENED and increment openCount when email.opened event arrives', async () => {
      const mockNotif = {
        id: 'notif-123',
        recipient: 'student@example.com',
        status: NotificationStatus.SENT,
        metadata: {
          resendEmailId: 're_test123',
          openCount: 0,
        },
      };

      mockPrisma.notification.findFirst.mockResolvedValue(mockNotif);
      mockPrisma.notification.update.mockResolvedValue({
        ...mockNotif,
        status: NotificationStatus.OPENED,
      });

      const result = await service.handleResendWebhookEvent({
        type: 'email.opened',
        created_at: '2026-08-19T18:00:00Z',
        data: {
          email_id: 're_test123',
        },
      });

      expect(result.handled).toBe(true);
      expect(result.eventType).toBe('email.opened');
      expect(mockPrisma.notification.update).toHaveBeenCalledWith({
        where: { id: 'notif-123' },
        data: expect.objectContaining({
          status: NotificationStatus.OPENED,
          metadata: expect.objectContaining({
            openCount: 1,
            openedAt: '2026-08-19T18:00:00Z',
          }),
        }),
      });
    });

    it('should update status to DELIVERED when email.delivered event arrives', async () => {
      const mockNotif = {
        id: 'notif-123',
        recipient: 'student@example.com',
        status: NotificationStatus.SENT,
        metadata: { resendEmailId: 're_test123' },
      };

      mockPrisma.notification.findFirst.mockResolvedValue(mockNotif);
      mockPrisma.notification.update.mockResolvedValue({
        ...mockNotif,
        status: NotificationStatus.DELIVERED,
      });

      const result = await service.handleResendWebhookEvent({
        type: 'email.delivered',
        data: {
          email_id: 're_test123',
        },
      });

      expect(result.handled).toBe(true);
      expect(mockPrisma.notification.update).toHaveBeenCalledWith({
        where: { id: 'notif-123' },
        data: expect.objectContaining({
          status: NotificationStatus.DELIVERED,
        }),
      });
    });
  });

  describe('NotificationsProcessor', () => {
    it('should process user email job via ResendService and update status to SENT', async () => {
      mockPrisma.notification.findUnique.mockResolvedValue({
        id: 'user-notif-1',
        metadata: {},
      });
      mockPrisma.notification.update.mockResolvedValue({
        id: 'user-notif-1',
        status: NotificationStatus.SENT,
      });

      const mockJob: any = {
        id: 'job-999',
        name: 'send-missing-fields-email',
        data: {
          notificationId: 'user-notif-1',
          studentId: mockUser.id,
          studentEmail: mockUser.email,
          studentName: mockUser.name,
          applicationTitle: 'Computer Science MSc',
          missingFields: [{ label: 'Passport Number' }],
          suggestedDocuments: ['IELTS Score Report'],
        },
      };

      const result = await processor.process(mockJob);

      expect(result.status).toBe('SENT');
      expect(result.recipient).toBe(mockUser.email);
      expect(mockResendService.sendEmail).toHaveBeenCalled();
      expect(mockPrisma.notification.update).toHaveBeenCalledWith({
        where: { id: 'user-notif-1' },
        data: expect.objectContaining({
          status: NotificationStatus.SENT,
          metadata: expect.objectContaining({
            resendEmailId: 're_test123',
          }),
        }),
      });
    });
  });
});


