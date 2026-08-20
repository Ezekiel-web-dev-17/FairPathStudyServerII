import { z } from 'zod';
import { NotificationStatus, NotificationType } from '@prisma/client';

export const TriggerMissingFieldsNotificationSchema = z.object({
  studentId: z.string().min(1, { message: 'studentId is required' }),
  applicationTitle: z.string().min(1, { message: 'applicationTitle is required' }),
  portalUrl: z.string().url().optional(),
  missingFields: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      label: z.string(),
      type: z.string(),
      required: z.boolean().optional(),
      section: z.string().optional(),
    }),
  ).default([]),
  suggestedDocuments: z.array(z.string()).default([]),
  customMessage: z.string().optional(),
});

export class TriggerMissingFieldsNotificationDto {
  studentId!: string;
  applicationTitle!: string;
  portalUrl?: string;
  missingFields!: Array<{
    id: string;
    name: string;
    label: string;
    type: string;
    required?: boolean;
    section?: string;
  }>;
  suggestedDocuments!: string[];
  customMessage?: string;
}

export const NotificationFilterSchema = z.object({
  recipient: z.string().optional(),
  userId: z.string().optional(),
  type: z.nativeEnum(NotificationType).optional(),
  status: z.nativeEnum(NotificationStatus).optional(),
  limit: z.coerce.number().min(1).max(100).default(20),
  offset: z.coerce.number().min(0).default(0),
});

export class NotificationFilterDto {
  recipient?: string;
  userId?: string;
  type?: NotificationType;
  status?: NotificationStatus;
  limit?: number;
  offset?: number;
}

export const UpdateNotificationStatusSchema = z.object({
  status: z.nativeEnum(NotificationStatus),
});

export class UpdateNotificationStatusDto {
  status!: NotificationStatus;
}

export const AdminSendUserEmailSchema = z.object({
  studentId: z.string().min(1, { message: 'studentId is required' }),
  subject: z.string().min(1).default('Required Documents & Information for Your Application'),
  message: z.string().min(1, { message: 'Message content is required' }),
  requestedDocuments: z.array(z.string()).default([]),
  requestedFields: z.array(z.string()).default([]),
  applicationTitle: z.string().optional(),
  portalUrl: z.string().url().optional(),
  adminSenderEmail: z.string().email().optional(),
});

export class AdminSendUserEmailDto {
  studentId!: string;
  subject?: string;
  message!: string;
  requestedDocuments!: string[];
  requestedFields!: string[];
  applicationTitle?: string;
  portalUrl?: string;
  adminSenderEmail?: string;
}

