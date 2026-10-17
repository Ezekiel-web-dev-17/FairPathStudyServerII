import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service.js';
import { ApplicationStatus, DocumentType, ProcessingStatus } from '@prisma/client';
import {
  AUTO_APPLY_QUEUE,
  IMissingDocsEvent,
  IAutoApplyJobPayload,
  IProcessApplicationResult,
  IPaginatedBlockedApplicationsResponse,
} from './applications.dto.js';

@Injectable()
export class ApplicationOrchestratorService {
  private readonly logger = new Logger(ApplicationOrchestratorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    @InjectQueue(AUTO_APPLY_QUEUE)
    private readonly autoApplyQueue: Queue<IAutoApplyJobPayload>,
  ) {}

  /**
   * Process an application based on its current state.
   * If the state is GATHERING_DOCS:
   * - Compares the required documents for the institution against the user's uploaded documents.
   * - If documents are missing: changes state to AWAITING_USER_INPUT and emits 'application.missing_docs'.
   * - If all documents are present: updates state to PROCESSING_AUTO_SUBMIT and pushes a job to 'auto-apply' queue.
   */
  async processApplication(applicationId: string): Promise<IProcessApplicationResult> {
    this.logger.log(`Evaluating application [ID: ${applicationId}]...`);

    // 1. Retrieve the application with its institution and user's documents
    const application = await this.prisma.application.findUnique({
      where: { id: applicationId },
      include: {
        institution: true,
        user: {
          include: {
            documents: true,
          },
        },
        documents: true,
      },
    });

    if (!application) {
      throw new NotFoundException(`Application with ID '${applicationId}' not found.`);
    }

    // 2. Check if the application state is GATHERING_DOCS
    if (application.status !== ApplicationStatus.GATHERING_DOCS) {
      this.logger.warn(
        `Application [ID: ${applicationId}] is currently in state '${application.status}' (expected '${ApplicationStatus.GATHERING_DOCS}'). Skipping document gathering checks.`,
      );
      return {
        applicationId: application.id,
        previousStatus: application.status,
        newStatus: application.status,
        requiredDocuments: [],
        uploadedDocuments: [],
        actionTaken: 'NO_OP',
        message: `Application is in '${application.status}' state, not '${ApplicationStatus.GATHERING_DOCS}'.`,
      };
    }

    // 3. Resolve required documents for the target institution
    const requiredDocs = this.resolveRequiredDocuments(application.institution);

    // 4. Gather user's uploaded and completed documents (scoping both user-level & application-specific attachments)
    const combinedDocs = [
      ...(application.user?.documents || []),
      ...(application.documents || []),
    ];

    const uploadedTypes = new Set<string>();
    for (const doc of combinedDocs) {
      // Document is considered valid if processing completed or has a valid stored file URL
      if (doc.status === ProcessingStatus.COMPLETED || doc.fileUrl) {
        uploadedTypes.add(doc.type.toUpperCase().trim());
      }
    }

    const uploadedList = Array.from(uploadedTypes);

    // 5. Compare required vs uploaded documents
    const missingDocs = requiredDocs.filter(
      (reqDoc) => !uploadedTypes.has(reqDoc.toUpperCase().trim()),
    );

    this.logger.log(
      `[Application ${applicationId}] Document Audit: ` +
        `Required: [${requiredDocs.join(', ')}], ` +
        `Uploaded: [${uploadedList.join(', ')}], ` +
        `Missing: [${missingDocs.join(', ')}]`,
    );

    // 6. Branch: If documents are missing
    if (missingDocs.length > 0) {
      // Transition state to AWAITING_USER_INPUT
      await this.prisma.application.update({
        where: { id: applicationId },
        data: {
          status: ApplicationStatus.AWAITING_USER_INPUT,
        },
      });

      const eventPayload: IMissingDocsEvent = {
        applicationId: application.id,
        userId: application.userId,
        institutionId: application.institutionId,
        institutionName: application.institution?.name || 'Unknown Institution',
        missingDocuments: missingDocs,
        uploadedDocuments: uploadedList,
        timestamp: new Date(),
      };

      // Emit NestJS EventEmitter event
      this.eventEmitter.emit('application.missing_docs', eventPayload);

      this.logger.warn(
        `Application [ID: ${applicationId}] has ${missingDocs.length} missing document(s). ` +
          `State moved to ${ApplicationStatus.AWAITING_USER_INPUT} and 'application.missing_docs' event emitted.`,
      );

      return {
        applicationId: application.id,
        previousStatus: ApplicationStatus.GATHERING_DOCS,
        newStatus: ApplicationStatus.AWAITING_USER_INPUT,
        missingDocuments: missingDocs,
        requiredDocuments: requiredDocs,
        uploadedDocuments: uploadedList,
        actionTaken: 'AWAITING_USER_INPUT_EMITTED',
        message: `Missing ${missingDocs.length} required document(s). Status moved to AWAITING_USER_INPUT.`,
      };
    }

    // 7. Branch: If all required documents are present
    // Transition state to PROCESSING_AUTO_SUBMIT
    await this.prisma.application.update({
      where: { id: applicationId },
      data: {
        status: ApplicationStatus.PROCESSING_AUTO_SUBMIT,
      },
    });

    // Push auto-apply job to BullMQ queue
    const job = await this.autoApplyQueue.add(
      'auto-apply-submission',
      {
        applicationId: application.id,
        userId: application.userId,
        institutionId: application.institutionId,
      },
      {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    this.logger.log(
      `All required documents verified for Application [ID: ${applicationId}]. ` +
        `State moved to ${ApplicationStatus.PROCESSING_AUTO_SUBMIT} and job enqueued to '${AUTO_APPLY_QUEUE}' [JobID: ${job.id}].`,
    );

    return {
      applicationId: application.id,
      previousStatus: ApplicationStatus.GATHERING_DOCS,
      newStatus: ApplicationStatus.PROCESSING_AUTO_SUBMIT,
      missingDocuments: [],
      requiredDocuments: requiredDocs,
      uploadedDocuments: uploadedList,
      actionTaken: 'PUSHED_TO_AUTO_APPLY_QUEUE',
      jobId: job.id as string,
      message: `All required documents present. Status moved to PROCESSING_AUTO_SUBMIT and job queued.`,
    };
  }

  /**
   * Helper to resolve required documents for an institution from its metadata,
   * falling back to standard study abroad requirements (PASSPORT, TRANSCRIPT).
   */
  private resolveRequiredDocuments(institution: any): string[] {
    if (institution?.metadata && typeof institution.metadata === 'object') {
      const meta = institution.metadata as Record<string, any>;
      if (Array.isArray(meta.requiredDocuments) && meta.requiredDocuments.length > 0) {
        return meta.requiredDocuments.map((doc: any) =>
          String(doc).toUpperCase().trim(),
        );
      }
    }

    // Standard baseline required documents for higher education study abroad
    return [DocumentType.PASSPORT, DocumentType.TRANSCRIPT];
  }

  /**
   * Retrieves a paginated list of applications in SUBMISSION_FAILED_ADMIN_REVIEW status.
   * Optimized for high concurrency and large data volumes:
   * - Leverages the @@index([status]) index on Application table.
   * - Uses explicit field selection (select) to exclude bulky JSON formData columns,
   *   substantially minimizing heap allocations and network transmission.
   * - Joins User and Institution relations with projected names/identifiers.
   * - Concurrently fires count and findMany in a single Promise.all.
   */
  async getBlockedApplications(
    page = 1,
    limit = 20,
  ): Promise<IPaginatedBlockedApplicationsResponse> {
    const validatedPage = Math.max(1, page);
    const validatedLimit = Math.min(100, Math.max(1, limit));
    const skip = (validatedPage - 1) * validatedLimit;

    const whereClause = {
      status: ApplicationStatus.SUBMISSION_FAILED_ADMIN_REVIEW,
    };

    const [totalRecords, applications] = await Promise.all([
      this.prisma.application.count({
        where: whereClause,
      }),
      this.prisma.application.findMany({
        where: whereClause,
        skip,
        take: validatedLimit,
        orderBy: {
          updatedAt: 'desc',
        },
        select: {
          id: true,
          status: true,
          programName: true,
          term: true,
          submittedAt: true,
          createdAt: true,
          updatedAt: true,
          submissionLogs: true,
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
        },
      }),
    ]);

    const totalPages = Math.ceil(totalRecords / validatedLimit);

    return {
      data: applications,
      pagination: {
        totalRecords,
        page: validatedPage,
        limit: validatedLimit,
        totalPages,
        hasNextPage: validatedPage < totalPages,
        hasPreviousPage: validatedPage > 1,
      },
    };
  }
}

