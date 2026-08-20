import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  NOTIFICATIONS_QUEUE,
  IMissingFieldsEmailJobData,
  IAdminAlertEmailJobData,
  IAdminToUserEmailJobData,
} from './notifications.processor.js';
import {
  TriggerMissingFieldsNotificationDto,
  NotificationFilterDto,
  AdminSendUserEmailDto,
} from './notifications.dto.js';
import { NotificationStatus, NotificationType, Notification } from '@prisma/client';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @InjectQueue(NOTIFICATIONS_QUEUE) private readonly notificationsQueue: Queue,
  ) {}

  /**
   * Trigger a missing fields notification:
   * 1. Creates an ADMIN_ACTION_REQUIRED notification in the database
   * 2. Creates a USER_EMAIL_REQUEST notification in the database (PENDING)
   * 3. Queues an async email job in BullMQ to deliver the email to the student
   * 4. Queues an async email job in BullMQ to alert the admin
   */
  async queueMissingFieldsNotification(dto: TriggerMissingFieldsNotificationDto): Promise<{
    adminNotification: Notification;
    userNotification: Notification;
    userJobId: string;
    adminJobId: string;
  }> {
    const {
      studentId,
      applicationTitle,
      portalUrl,
      missingFields,
      suggestedDocuments,
      customMessage,
    } = dto;

    const adminEmail = this.configService.get<string>('ADMIN_EMAIL', 'admin@fairpath.study');

    // 1. Verify student exists
    const student = await this.prisma.user.findUnique({
      where: { id: studentId },
    });

    if (!student) {
      throw new NotFoundException(`Student user with ID '${studentId}' not found.`);
    }

    const studentName = student.name || 'Student';
    const studentEmail = student.email;
    const missingCount = (missingFields?.length || 0) + (suggestedDocuments?.length || 0);

    // 2. Create Admin Notification in Database
    const adminNotification = await this.prisma.notification.create({
      data: {
        recipient: adminEmail,
        userId: student.id,
        type: NotificationType.ADMIN_ACTION_REQUIRED,
        status: NotificationStatus.PENDING,
        title: `Missing Application Input: ${studentName} (${applicationTitle})`,
        message: `Student ${studentName} (${studentEmail}) is missing ${missingCount} required item(s) for "${applicationTitle}". Notification emails queued.`,
        metadata: {
          studentId: student.id,
          studentEmail,
          adminEmail,
          applicationTitle,
          portalUrl,
          missingFieldsCount: missingFields?.length || 0,
          missingFields,
          suggestedDocumentsCount: suggestedDocuments?.length || 0,
          suggestedDocuments,
          customMessage,
        },
      },
    });

    // 3. Create User Email Notification Record in Database (PENDING)
    const userNotification = await this.prisma.notification.create({
      data: {
        recipient: studentEmail,
        userId: student.id,
        type: NotificationType.USER_EMAIL_REQUEST,
        status: NotificationStatus.PENDING,
        title: `Action Required: Complete your application for ${applicationTitle}`,
        message: `Please provide missing application fields and required documents for "${applicationTitle}".`,
        metadata: {
          adminNotificationId: adminNotification.id,
          applicationTitle,
          portalUrl,
          missingFields,
          suggestedDocuments,
          customMessage,
        },
      },
    });

    // 4. Enqueue BullMQ Email Job for Student
    const userJobPayload: IMissingFieldsEmailJobData = {
      notificationId: userNotification.id,
      studentId: student.id,
      studentEmail,
      studentName,
      applicationTitle,
      portalUrl,
      missingFields: missingFields || [],
      suggestedDocuments: suggestedDocuments || [],
      customMessage,
    };

    const userJob = await this.notificationsQueue.add(
      'send-missing-fields-email',
      userJobPayload,
      {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: true,
      },
    );

    // 5. Enqueue BullMQ Email Job for Admin Alert
    const adminJobPayload: IAdminAlertEmailJobData = {
      notificationId: adminNotification.id,
      adminEmail,
      studentId: student.id,
      studentEmail,
      studentName,
      applicationTitle,
      portalUrl,
      missingFields: missingFields || [],
      suggestedDocuments: suggestedDocuments || [],
      customMessage,
    };

    const adminJob = await this.notificationsQueue.add(
      'send-admin-alert-email',
      adminJobPayload,
      {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: true,
      },
    );

    this.logger.log(
      `Enqueued user email job [ID: ${userJob.id}] to ${studentEmail} and admin alert job [ID: ${adminJob.id}] to ${adminEmail}.`,
    );

    return {
      adminNotification,
      userNotification,
      userJobId: userJob.id as string,
      adminJobId: adminJob.id as string,
    };
  }

  /**
   * Admin-initiated email to a student:
   * Allows an admin to review missing documents and send a direct, customized email request.
   */
  async adminSendEmailToUser(dto: AdminSendUserEmailDto): Promise<{
    notification: Notification;
    jobId: string;
  }> {
    const {
      studentId,
      subject = 'Required Documents & Information for Your Application',
      message,
      requestedDocuments,
      requestedFields,
      applicationTitle,
      portalUrl,
      adminSenderEmail,
    } = dto;

    const senderEmail = adminSenderEmail || this.configService.get<string>('ADMIN_EMAIL', 'admin@fairpath.study');

    // 1. Verify student exists
    const student = await this.prisma.user.findUnique({
      where: { id: studentId },
    });

    if (!student) {
      throw new NotFoundException(`Student user with ID '${studentId}' not found.`);
    }

    const studentName = student.name || 'Student';
    const studentEmail = student.email;

    // 2. Create User Notification record in Database
    const notification = await this.prisma.notification.create({
      data: {
        recipient: studentEmail,
        userId: student.id,
        type: NotificationType.USER_EMAIL_REQUEST,
        status: NotificationStatus.PENDING,
        title: subject,
        message: message,
        metadata: {
          sentByAdmin: senderEmail,
          applicationTitle,
          portalUrl,
          requestedDocuments,
          requestedFields,
        },
      },
    });

    // 3. Enqueue Admin-to-User Email Job
    const jobPayload: IAdminToUserEmailJobData = {
      notificationId: notification.id,
      studentId: student.id,
      studentEmail,
      studentName,
      adminSenderEmail: senderEmail,
      subject,
      message,
      requestedDocuments: requestedDocuments || [],
      requestedFields: requestedFields || [],
      applicationTitle,
      portalUrl,
    };

    const job = await this.notificationsQueue.add(
      'send-admin-to-user-email',
      jobPayload,
      {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: true,
      },
    );

    this.logger.log(
      `Admin (${senderEmail}) enqueued direct email [Job ID: ${job.id}] to student ${studentEmail}.`,
    );

    return {
      notification,
      jobId: job.id as string,
    };
  }

  /**
   * Query notifications from DB with optional filters
   */
  async listNotifications(filters: NotificationFilterDto): Promise<{
    notifications: Notification[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const { recipient, userId, type, status, limit = 20, offset = 0 } = filters;

    const where: any = {};
    if (recipient) where.recipient = recipient;
    if (userId) where.userId = userId;
    if (type) where.type = type;
    if (status) where.status = status;

    const [notifications, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        take: limit,
        skip: offset,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              name: true,
            },
          },
        },
      }),
      this.prisma.notification.count({ where }),
    ]);

    return {
      notifications,
      total,
      limit,
      offset,
    };
  }

  /**
   * Find single notification by ID
   */
  async getNotificationById(id: string): Promise<Notification> {
    const notification = await this.prisma.notification.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    });

    if (!notification) {
      throw new NotFoundException(`Notification with ID '${id}' not found.`);
    }

    return notification;
  }

  /**
   * Update notification status (e.g. mark ADMIN_ACTION_REQUIRED as RESOLVED)
   */
  async updateNotificationStatus(id: string, status: NotificationStatus): Promise<Notification> {
    const existing = await this.prisma.notification.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`Notification with ID '${id}' not found.`);
    }

    return this.prisma.notification.update({
      where: { id },
      data: {
        status,
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Process incoming Resend Webhook event (email.opened, email.delivered, email.bounced, email.clicked)
   */
  async handleResendWebhookEvent(event: {
    type: string;
    created_at?: string;
    data?: {
      email_id?: string;
      to?: string[];
      subject?: string;
      click?: { link?: string };
    };
  }): Promise<{ handled: boolean; eventType: string; notificationId?: string }> {
    const eventType = event?.type;
    const resendEmailId = event?.data?.email_id;

    if (!eventType || !resendEmailId) {
      this.logger.warn(`Resend webhook received with missing eventType or email_id: ${JSON.stringify(event)}`);
      return { handled: false, eventType: eventType || 'unknown' };
    }

    this.logger.log(`Processing Resend webhook [Type: ${eventType}] for email ID: ${resendEmailId}`);

    // Look up notification by resendEmailId in JSON metadata
    const notification = await this.prisma.notification.findFirst({
      where: {
        metadata: {
          path: ['resendEmailId'],
          equals: resendEmailId,
        },
      },
    });

    if (!notification) {
      this.logger.warn(`No notification found with resendEmailId: ${resendEmailId}`);
      return { handled: false, eventType, notificationId: undefined };
    }

    const currentMetadata = (notification.metadata as Record<string, any>) || {};
    const timestamp = event.created_at || new Date().toISOString();

    switch (eventType) {
      case 'email.opened': {
        const currentCount = typeof currentMetadata.openCount === 'number' ? currentMetadata.openCount : 0;
        await this.prisma.notification.update({
          where: { id: notification.id },
          data: {
            status: NotificationStatus.OPENED,
            metadata: {
              ...currentMetadata,
              openedAt: timestamp,
              firstOpenedAt: currentMetadata.firstOpenedAt || timestamp,
              openCount: currentCount + 1,
            },
            updatedAt: new Date(),
          },
        });
        this.logger.log(
          `Notification ${notification.id} marked as OPENED (Read Count: ${currentCount + 1}) for recipient ${notification.recipient}`,
        );
        break;
      }
      case 'email.delivered': {
        if (notification.status !== NotificationStatus.OPENED) {
          await this.prisma.notification.update({
            where: { id: notification.id },
            data: {
              status: NotificationStatus.DELIVERED,
              metadata: {
                ...currentMetadata,
                deliveredAt: timestamp,
              },
              updatedAt: new Date(),
            },
          });
        }
        break;
      }
      case 'email.bounced': {
        await this.prisma.notification.update({
          where: { id: notification.id },
          data: {
            status: NotificationStatus.BOUNCED,
            metadata: {
              ...currentMetadata,
              bouncedAt: timestamp,
            },
            updatedAt: new Date(),
          },
        });
        break;
      }
      case 'email.clicked': {
        const existingClicks = Array.isArray(currentMetadata.clicks) ? currentMetadata.clicks : [];
        await this.prisma.notification.update({
          where: { id: notification.id },
          data: {
            metadata: {
              ...currentMetadata,
              clicks: [...existingClicks, { link: event.data?.click?.link, clickedAt: timestamp }],
            },
            updatedAt: new Date(),
          },
        });
        break;
      }
      default:
        this.logger.log(`Resend event '${eventType}' acknowledged.`);
    }

    return { handled: true, eventType, notificationId: notification.id };
  }
}

