import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { INSTITUTION_UPDATES_QUEUE, ScraperService } from './scraper.service.js';
import {
  IInstitutionUpdateJobData,
  IInstitutionScrapedData,
} from './scraper.dto.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '@prisma/client';

@Processor(INSTITUTION_UPDATES_QUEUE)
export class InstitutionUpdatesProcessor extends WorkerHost {
  private readonly logger = new Logger(InstitutionUpdatesProcessor.name);

  constructor(
    private readonly scraperService: ScraperService,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  /**
   * Process an institution update job.
   * Navigates to the university URL with Playwright, extracts:
   * 1. Application Deadline
   * 2. Estimated Tuition
   * 3. Newsletter / Recent News items
   *
   * If a timeout or anti-bot challenge (e.g., Cloudflare) is encountered,
   * catches the error, logs it with context, and transitions the job to a
   * FAILED state without crashing the host application.
   */
  async process(job: Job<IInstitutionUpdateJobData>): Promise<IInstitutionScrapedData> {
    const { universityUrl, institutionId } = job.data;
    this.logger.log(
      `[Job ${job.id}] Processing university update for URL: ${universityUrl}`,
    );

    try {
      // Execute Playwright scraping with timeout and anti-bot guards
      const scrapedData = await this.scraperService.scrapeWithPlaywright(universityUrl);

      this.logger.log(
        `[Job ${job.id}] Scraped data extracted successfully for ${universityUrl}. ` +
          `Deadline: "${scrapedData.applicationDeadline ?? 'Not found'}", ` +
          `Tuition: "${scrapedData.estimatedTuition ?? 'Not found'}", ` +
          `News Items: ${scrapedData.recentNews.length}`,
      );

      // Optionally synchronize with Institution model in Prisma if institutionId was provided
      if (institutionId) {
        await this.syncInstitutionRecord(institutionId, scrapedData);
      }

      return scrapedData;
    } catch (error: any) {
      // Diagnostic logging: isolate scraping failure (e.g. Cloudflare / timeout)
      this.logger.error(
        `[Job ${job.id}] University scrape failed for ${universityUrl}: ${error.message}`,
        error.stack,
      );

      // Re-throwing inside WorkerHost.process ensures BullMQ transitions
      // the job to the 'failed' state with failedReason, while preventing an
      // unhandled promise rejection from crashing the application.
      throw new Error(`Institution scraping failed: ${error.message}`);
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    this.logger.warn(
      `[Job ${job?.id}] Job moved to FAILED state. Target: ${job?.data?.universityUrl}. Reason: ${error.message}`,
    );
  }

  @OnWorkerEvent('error')
  onError(error: Error) {
    this.logger.error(
      `[Worker Error] Unexpected error in ${INSTITUTION_UPDATES_QUEUE} worker: ${error.message}`,
      error.stack,
    );
  }

  /**
   * Helper to persist scraped updates into the Institution metadata column
   */
  private async syncInstitutionRecord(
    institutionId: string,
    scrapedData: IInstitutionScrapedData,
  ): Promise<void> {
    try {
      const institution = await this.prisma.institution.findUnique({
        where: { id: institutionId },
      });

      if (institution) {
        const currentMeta =
          typeof institution.metadata === 'object' && institution.metadata !== null
            ? (institution.metadata as Record<string, any>)
            : {};

        await this.prisma.institution.update({
          where: { id: institutionId },
          data: {
            metadata: {
              ...currentMeta,
              scrapedDeadline: scrapedData.applicationDeadline,
              scrapedTuition: scrapedData.estimatedTuition,
              recentNews: scrapedData.recentNews as unknown as Prisma.InputJsonValue,
              lastScrapedAt: scrapedData.scrapedAt,
              pageTitle: scrapedData.pageTitle,
            },
          },
        });

        this.logger.log(
          `Updated Institution metadata in database for ID: ${institutionId}`,
        );
      }
    } catch (dbError: any) {
      this.logger.error(
        `Failed to update Institution [ID: ${institutionId}] in DB: ${dbError.message}`,
      );
    }
  }
}
