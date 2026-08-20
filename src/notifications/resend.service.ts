import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

export interface ISendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from?: string;
  replyTo?: string;
  tags?: Array<{ name: string; value: string }>;
}

export interface ISendEmailResult {
  id: string;
  isMock: boolean;
}

@Injectable()
export class ResendService implements OnModuleInit {
  private readonly logger = new Logger(ResendService.name);
  private resendClient: Resend | null = null;
  private defaultFromEmail: string = 'FairPath Admissions <onboarding@resend.dev>';

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const apiKey = this.configService.get<string>('RESEND_API_KEY', '').trim();
    const fromEmail = this.configService.get<string>('RESEND_FROM_EMAIL', '').trim();

    if (fromEmail) {
      this.defaultFromEmail = fromEmail;
    }

    if (apiKey) {
      this.resendClient = new Resend(apiKey);
      this.logger.log('Resend client initialized successfully with API key.');
    } else {
      this.logger.warn(
        'RESEND_API_KEY is not configured in .env. Emails will run in simulated development mode.',
      );
    }
  }

  get isConfigured(): boolean {
    return this.resendClient !== null;
  }

  /**
   * Send an email via Resend (or simulate if no API key is present)
   */
  async sendEmail(options: ISendEmailOptions): Promise<ISendEmailResult> {
    const from = options.from || this.defaultFromEmail;

    if (this.resendClient) {
      try {
        const response = await this.resendClient.emails.send({
          from,
          to: options.to,
          subject: options.subject,
          html: options.html,
          text: options.text,
          replyTo: options.replyTo,
          tags: options.tags,
        });

        if (response.error) {
          this.logger.error(`Resend API returned error: ${response.error.message}`);
          throw new Error(`Resend error: ${response.error.message}`);
        }

        const id = response.data?.id || `resend_${Date.now()}`;
        this.logger.log(`Email dispatched via Resend to ${options.to} [ID: ${id}]`);
        return { id, isMock: false };
      } catch (error: any) {
        this.logger.error(`Failed to send email via Resend: ${error.message}`, error.stack);
        throw error;
      }
    }

    // Simulated local fallback
    const mockId = `sim_resend_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    this.logger.log(
      `[SIMULATED EMAIL DISPATCH - Resend Mock]\nTo: ${options.to}\nFrom: ${from}\nSubject: ${options.subject}\nMock Email ID: ${mockId}`,
    );

    return { id: mockId, isMock: true };
  }

  /**
   * Render a responsive HTML email template with FairPath branding
   */
  renderHtmlTemplate(params: {
    title: string;
    preheader?: string;
    studentName?: string;
    mainParagraph: string;
    bulletSectionTitle?: string;
    bulletItems?: string[];
    notes?: string;
    actionButtonText?: string;
    actionButtonUrl?: string;
    senderName?: string;
  }): string {
    const {
      title,
      preheader,
      studentName,
      mainParagraph,
      bulletSectionTitle,
      bulletItems = [],
      notes,
      actionButtonText,
      actionButtonUrl,
      senderName = 'FairPath Admissions Office',
    } = params;

    const bulletListHtml =
      bulletItems.length > 0
        ? `
        <div style="margin: 20px 0; background-color: #f8fafc; border-left: 4px solid #3b82f6; padding: 16px; border-radius: 4px;">
          <h3 style="margin: 0 0 10px 0; font-size: 15px; color: #1e293b; font-weight: 600;">${bulletSectionTitle || 'Required Items'}:</h3>
          <ul style="margin: 0; padding-left: 20px; color: #334155; font-size: 14px; line-height: 1.6;">
            ${bulletItems.map((item) => `<li style="margin-bottom: 6px;"><strong>${item}</strong></li>`).join('')}
          </ul>
        </div>
      `
        : '';

    const notesHtml = notes
      ? `
        <div style="margin: 16px 0; padding: 12px 16px; background-color: #fefce8; border-left: 4px solid #eab308; border-radius: 4px;">
          <p style="margin: 0; font-size: 13px; color: #713f12;"><strong>Counselor Note:</strong> ${notes}</p>
        </div>
      `
      : '';

    const actionButtonHtml =
      actionButtonText && actionButtonUrl
        ? `
        <div style="margin: 28px 0; text-align: center;">
          <a href="${actionButtonUrl}" style="background-color: #2563eb; color: #ffffff; padding: 12px 28px; text-decoration: none; font-size: 14px; font-weight: 600; border-radius: 6px; display: inline-block;">${actionButtonText}</a>
        </div>
      `
        : '';

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${title}</title>
        ${preheader ? `<span style="display:none;font-size:0px;color:#fff;line-height:0px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">${preheader}</span>` : ''}
      </head>
      <body style="margin: 0; padding: 0; background-color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
        <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #f1f5f9; padding: 40px 10px;">
          <tr>
            <td align="center">
              <table width="600" border="0" cellspacing="0" cellpadding="0" style="background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
                <!-- Header -->
                <tr>
                  <td style="background-color: #1e3a8a; padding: 24px 32px; text-align: left;">
                    <h1 style="margin: 0; color: #ffffff; font-size: 20px; font-weight: 700; letter-spacing: -0.5px;">FairPath Study</h1>
                  </td>
                </tr>
                <!-- Content -->
                <tr>
                  <td style="padding: 32px;">
                    <h2 style="margin: 0 0 16px 0; font-size: 18px; color: #0f172a;">${title}</h2>
                    <p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.6; color: #334155;">
                      Dear ${studentName || 'Applicant'},
                    </p>
                    <p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.6; color: #334155;">
                      ${mainParagraph}
                    </p>
                    ${bulletListHtml}
                    ${notesHtml}
                    ${actionButtonHtml}
                    <p style="margin: 24px 0 0 0; font-size: 14px; line-height: 1.5; color: #64748b;">
                      Sincerely,<br>
                      <strong style="color: #334155;">${senderName}</strong>
                    </p>
                  </td>
                </tr>
                <!-- Footer -->
                <tr>
                  <td style="background-color: #f8fafc; padding: 16px 32px; border-top: 1px solid #e2e8f0; text-align: center;">
                    <p style="margin: 0; font-size: 12px; color: #94a3b8;">
                      © ${new Date().getFullYear()} FairPath Study. All rights reserved.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `;
  }
}
