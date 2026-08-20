import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  Query,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service.js';
import {
  TriggerMissingFieldsNotificationSchema,
  NotificationFilterSchema,
  UpdateNotificationStatusSchema,
  AdminSendUserEmailSchema,
  TriggerMissingFieldsNotificationDto,
  NotificationFilterDto,
  UpdateNotificationStatusDto,
  AdminSendUserEmailDto,
} from './notifications.dto.js';

@ApiTags('Notifications & Email Queue')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Post('trigger-missing-fields')
  @ApiOperation({
    summary: 'Trigger missing fields email to student and notify admin',
    description:
      'Creates an ADMIN_ACTION_REQUIRED notification, a USER_EMAIL_REQUEST notification, and enqueues an email job in BullMQ to request missing fields/documents from the applicant.',
  })
  @ApiResponse({ status: 201, description: 'Notification created and email job enqueued successfully.' })
  @ApiResponse({ status: 400, description: 'Validation failed.' })
  @ApiResponse({ status: 404, description: 'Student not found.' })
  async triggerMissingFields(@Body() body: TriggerMissingFieldsNotificationDto) {
    const parseResult = TriggerMissingFieldsNotificationSchema.safeParse(body);
    if (!parseResult.success) {
      const messages = parseResult.error.issues
        ? parseResult.error.issues.map((e) => e.message).join(', ')
        : parseResult.error.message;
      throw new BadRequestException(messages);
    }
    return this.notificationsService.queueMissingFieldsNotification(parseResult.data);
  }

  @Post('admin/send-email-to-user')
  @ApiOperation({
    summary: 'Send customized email from admin to student regarding required documents/fields',
    description:
      'Allows an administrator to draft a custom message with a list of required documents/fields and dispatch it via the background email queue to the student.',
  })
  @ApiResponse({ status: 201, description: 'Admin email enqueued and notification logged successfully.' })
  @ApiResponse({ status: 400, description: 'Validation failed.' })
  @ApiResponse({ status: 404, description: 'Student not found.' })
  async adminSendEmailToUser(@Body() body: AdminSendUserEmailDto) {
    const parseResult = AdminSendUserEmailSchema.safeParse(body);
    if (!parseResult.success) {
      const messages = parseResult.error.issues
        ? parseResult.error.issues.map((e) => e.message).join(', ')
        : parseResult.error.message;
      throw new BadRequestException(messages);
    }
    return this.notificationsService.adminSendEmailToUser(parseResult.data);
  }

  @Get()
  @ApiOperation({ summary: 'List notifications with optional filters (recipient, status, type)' })
  @ApiResponse({ status: 200, description: 'List of notifications retrieved successfully.' })
  async listNotifications(@Query() query: NotificationFilterDto) {
    const parseResult = NotificationFilterSchema.safeParse(query);
    if (!parseResult.success) {
      const messages = parseResult.error.issues
        ? parseResult.error.issues.map((e) => e.message).join(', ')
        : parseResult.error.message;
      throw new BadRequestException(messages);
    }
    return this.notificationsService.listNotifications(parseResult.data);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get details of a single notification by ID' })
  @ApiResponse({ status: 200, description: 'Notification details retrieved.' })
  @ApiResponse({ status: 404, description: 'Notification not found.' })
  async getNotification(@Param('id') id: string) {
    return this.notificationsService.getNotificationById(id);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Update notification status (e.g. mark as RESOLVED, SENT, or PENDING)' })
  @ApiResponse({ status: 200, description: 'Notification status updated successfully.' })
  async updateStatus(
    @Param('id') id: string,
    @Body() body: UpdateNotificationStatusDto,
  ) {
    const parseResult = UpdateNotificationStatusSchema.safeParse(body);
    if (!parseResult.success) {
      const messages = parseResult.error.issues
        ? parseResult.error.issues.map((e) => e.message).join(', ')
        : parseResult.error.message;
      throw new BadRequestException(messages);
    }
    return this.notificationsService.updateNotificationStatus(id, parseResult.data.status);
  }

  @Post('webhooks/resend')
  @ApiOperation({
    summary: 'Webhook endpoint for Resend email events (email.opened, email.delivered, email.bounced, email.clicked)',
    description:
      'Receives webhook callbacks from Resend to automatically update email open/read status in real-time.',
  })
  @ApiResponse({ status: 200, description: 'Webhook processed.' })
  async handleResendWebhook(@Body() payload: any) {
    return this.notificationsService.handleResendWebhookEvent(payload);
  }
}

