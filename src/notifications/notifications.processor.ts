import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service.js';
import { ResendService } from './resend.service.js';
import { NotificationStatus } from '@prisma/client';

export const NOTIFICATIONS_QUEUE = 'notifications-queue';

export interface IMissingFieldsEmailJobData {
  notificationId: string;
  studentId: string;
  studentEmail: string;
  studentName: string;
  applicationTitle: string;
  portalUrl?: string;
  missingFields: Array<{
    id: string;
    name: string;
    label: string;
    type: string;
    required?: boolean;
    section?: string;
  }>;
  suggestedDocuments: string[];
  customMessage?: string;
}

export interface IAdminAlertEmailJobData {
  notificationId: string;
  adminEmail: string;
  studentId: string;
  studentEmail: string;
  studentName: string;
  applicationTitle: string;
  portalUrl?: string;
  missingFields: Array<{ label: string; section?: string }>;
  suggestedDocuments: string[];
  customMessage?: string;
}

export interface IAdminToUserEmailJobData {
  notificationId: string;
  studentId: string;
  studentEmail: string;
  studentName: string;
  adminSenderEmail?: string;
  subject: string;
  message: string;
  requestedDocuments: string[];
  requestedFields: string[];
  applicationTitle?: string;
  portalUrl?: string;
}

@Processor(NOTIFICATIONS_QUEUE)
export class NotificationsProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationsProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly resendService: ResendService,
  ) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    this.logger.log(`Processing job ${job.id} [${job.name}]`);

    switch (job.name) {
      case 'send-missing-fields-email':
        return this.handleSendMissingFieldsEmail(job.data as IMissingFieldsEmailJobData, job.id);
      case 'send-admin-alert-email':
        return this.handleSendAdminAlertEmail(job.data as IAdminAlertEmailJobData, job.id);
      case 'send-admin-to-user-email':
        return this.handleSendAdminToUserEmail(job.data as IAdminToUserEmailJobData, job.id);
      default:
        this.logger.warn(`Unhandled job name: ${job.name}`);
        return { status: 'skipped' };
    }
  }

  private async handleSendMissingFieldsEmail(
    data: IMissingFieldsEmailJobData,
    jobId?: string,
  ): Promise<{ status: string; recipient: string; resendId: string; sentAt: string }> {
    const {
      notificationId,
      studentEmail,
      studentName,
      applicationTitle,
      portalUrl,
      missingFields,
      suggestedDocuments,
      customMessage,
    } = data;

    this.logger.log(
      `[Job ${jobId}] Preparing automated email to ${studentEmail} (${studentName}) for "${applicationTitle}"`,
    );

    try {
      const bulletItems: string[] = [
        ...missingFields.map((f) => `Form Field: ${f.label}${f.section ? ` (${f.section})` : ''}`),
        ...suggestedDocuments.map((d) => `Document: ${d}`),
      ];

      const html = this.resendService.renderHtmlTemplate({
        title: `Action Required: Complete your application for ${applicationTitle}`,
        studentName,
        mainParagraph: `We are assisting you with your application for <strong>${applicationTitle}</strong>. To complete and submit your application, please provide the following required information and documents:`,
        bulletSectionTitle: 'Missing Application Items',
        bulletItems,
        notes: customMessage,
        actionButtonText: 'Access Application Portal',
        actionButtonUrl: portalUrl || 'https://fairpath.study',
      });

      const textBody = this.generateMissingFieldsEmailBody({
        studentName,
        applicationTitle,
        portalUrl,
        missingFields,
        suggestedDocuments,
        customMessage,
      });

      const sendResult = await this.resendService.sendEmail({
        to: studentEmail,
        subject: `Action Required: Complete your application for ${applicationTitle}`,
        html,
        text: textBody,
        tags: [
          { name: 'notificationId', value: notificationId },
          { name: 'type', value: 'missing_fields_alert' },
        ],
      });

      const existing = await this.prisma.notification.findUnique({ where: { id: notificationId } });
      const currentMetadata = (existing?.metadata as Record<string, any>) || {};

      await this.prisma.notification.update({
        where: { id: notificationId },
        data: {
          status: NotificationStatus.SENT,
          metadata: {
            ...currentMetadata,
            resendEmailId: sendResult.id,
            isMockEmail: sendResult.isMock,
            sentAt: new Date().toISOString(),
          },
          updatedAt: new Date(),
        },
      });

      return {
        status: 'SENT',
        recipient: studentEmail,
        resendId: sendResult.id,
        sentAt: new Date().toISOString(),
      };
    } catch (error: any) {
      this.logger.error(
        `[Job ${jobId}] Failed to process email for notification ${notificationId}: ${error.message}`,
        error.stack,
      );

      await this.prisma.notification.update({
        where: { id: notificationId },
        data: {
          status: NotificationStatus.FAILED,
          updatedAt: new Date(),
        },
      });

      throw error;
    }
  }

  private async handleSendAdminAlertEmail(
    data: IAdminAlertEmailJobData,
    jobId?: string,
  ): Promise<{ status: string; recipient: string; resendId: string; sentAt: string }> {
    const {
      notificationId,
      adminEmail,
      studentId,
      studentEmail,
      studentName,
      applicationTitle,
      portalUrl,
      missingFields,
      suggestedDocuments,
      customMessage,
    } = data;

    this.logger.log(`[Job ${jobId}] Preparing admin alert email to ${adminEmail}`);

    try {
      const bulletItems: string[] = [
        ...suggestedDocuments.map((d) => `Missing Document: ${d}`),
        ...missingFields.map((f) => `Missing Field: ${f.label}`),
      ];

      const html = this.resendService.renderHtmlTemplate({
        title: `Applicant Missing Documents Alert`,
        studentName: 'Admissions Administrator',
        mainParagraph: `Student <strong>${studentName}</strong> (Email: ${studentEmail}, ID: ${studentId}) has submitted an application for <strong>${applicationTitle}</strong> with missing required items:`,
        bulletSectionTitle: 'Missing Requirements Checklist',
        bulletItems,
        notes: customMessage,
        actionButtonText: 'Review in Admin Dashboard',
        actionButtonUrl: portalUrl || 'https://fairpath.study/admin',
      });

      const textBody = `ADMIN ALERT: Missing Application Documents & Information\nStudent: ${studentName} (${studentEmail})\nApplication: ${applicationTitle}\nMissing Items:\n${bulletItems.join('\n')}`;

      const sendResult = await this.resendService.sendEmail({
        to: adminEmail,
        subject: `[Admin Alert] Missing application documents for ${studentName}`,
        html,
        text: textBody,
        tags: [
          { name: 'notificationId', value: notificationId },
          { name: 'type', value: 'admin_alert' },
        ],
      });

      const existing = await this.prisma.notification.findUnique({ where: { id: notificationId } });
      const currentMetadata = (existing?.metadata as Record<string, any>) || {};

      await this.prisma.notification.update({
        where: { id: notificationId },
        data: {
          status: NotificationStatus.SENT,
          metadata: {
            ...currentMetadata,
            resendEmailId: sendResult.id,
            isMockEmail: sendResult.isMock,
            sentAt: new Date().toISOString(),
          },
          updatedAt: new Date(),
        },
      });

      return {
        status: 'SENT',
        recipient: adminEmail,
        resendId: sendResult.id,
        sentAt: new Date().toISOString(),
      };
    } catch (error: any) {
      this.logger.error(`[Job ${jobId}] Failed to dispatch admin alert email: ${error.message}`);
      throw error;
    }
  }

  private async handleSendAdminToUserEmail(
    data: IAdminToUserEmailJobData,
    jobId?: string,
  ): Promise<{ status: string; recipient: string; resendId: string; sentAt: string }> {
    const {
      notificationId,
      studentEmail,
      studentName,
      adminSenderEmail,
      subject,
      message,
      requestedDocuments,
      requestedFields,
      applicationTitle,
      portalUrl,
    } = data;

    this.logger.log(
      `[Job ${jobId}] Sending admin-composed email to ${studentEmail} from ${adminSenderEmail || 'Admissions Team'}`,
    );

    try {
      const bulletItems: string[] = [
        ...requestedDocuments.map((doc) => `Document to Upload: ${doc}`),
        ...requestedFields.map((field) => `Required Field: ${field}`),
      ];

      const html = this.resendService.renderHtmlTemplate({
        title: subject,
        studentName,
        mainParagraph: message,
        bulletSectionTitle: bulletItems.length > 0 ? 'Specific Items Requested by Admissions' : undefined,
        bulletItems,
        actionButtonText: 'Upload Documents / Update Application',
        actionButtonUrl: portalUrl || 'https://fairpath.study/student/documents',
        senderName: adminSenderEmail ? `Admissions Advisor (${adminSenderEmail})` : 'FairPath Admissions Office',
      });

      const textBody = `Dear ${studentName},\n\n${message}\n\n${bulletItems.join('\n')}\n\nSincerely,\n${adminSenderEmail || 'FairPath Admissions'}`;

      const sendResult = await this.resendService.sendEmail({
        to: studentEmail,
        subject,
        html,
        text: textBody,
        replyTo: adminSenderEmail,
        tags: [
          { name: 'notificationId', value: notificationId },
          { name: 'type', value: 'admin_direct_message' },
        ],
      });

      const existing = await this.prisma.notification.findUnique({ where: { id: notificationId } });
      const currentMetadata = (existing?.metadata as Record<string, any>) || {};

      await this.prisma.notification.update({
        where: { id: notificationId },
        data: {
          status: NotificationStatus.SENT,
          metadata: {
            ...currentMetadata,
            resendEmailId: sendResult.id,
            isMockEmail: sendResult.isMock,
            sentAt: new Date().toISOString(),
          },
          updatedAt: new Date(),
        },
      });

      return {
        status: 'SENT',
        recipient: studentEmail,
        resendId: sendResult.id,
        sentAt: new Date().toISOString(),
      };
    } catch (error: any) {
      this.logger.error(`[Job ${jobId}] Failed to send admin-to-user email: ${error.message}`);
      await this.prisma.notification.update({
        where: { id: notificationId },
        data: {
          status: NotificationStatus.FAILED,
          updatedAt: new Date(),
        },
      });
      throw error;
    }
  }

  private generateMissingFieldsEmailBody(params: {
    studentName: string;
    applicationTitle: string;
    portalUrl?: string;
    missingFields: Array<{ label: string; section?: string }>;
    suggestedDocuments: string[];
    customMessage?: string;
  }): string {
    const { studentName, applicationTitle, portalUrl, missingFields, suggestedDocuments, customMessage } = params;

    let body = `Dear ${studentName || 'Student'},\n\n`;
    body += `We are assisting you with your application for "${applicationTitle}".\n`;
    if (portalUrl) {
      body += `Application Portal: ${portalUrl}\n`;
    }
    body += `\nTo complete and submit your application, please provide the following required information:\n\n`;

    if (missingFields.length > 0) {
      body += `--- REQUIRED FORM FIELDS ---\n`;
      missingFields.forEach((field, i) => {
        body += `${i + 1}. ${field.label}${field.section ? ` (${field.section})` : ''}\n`;
      });
      body += `\n`;
    }

    if (suggestedDocuments.length > 0) {
      body += `--- REQUIRED DOCUMENTS ---\n`;
      suggestedDocuments.forEach((doc, i) => {
        body += `${i + 1}. ${doc}\n`;
      });
      body += `\n`;
    }

    if (customMessage) {
      body += `Additional Notes from Counselor:\n${customMessage}\n\n`;
    }

    body += `Please log in to your FairPath portal to update your profile or upload the documents.\n\n`;
    body += `Best regards,\nFairPath Study Support Team`;

    return body;
  }
}
