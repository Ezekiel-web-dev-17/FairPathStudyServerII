import { ApplicationStatus } from '@prisma/client';
import { z } from 'zod';

export const AUTO_APPLY_QUEUE = 'auto-apply';

export interface IMissingDocsEvent {
  applicationId: string;
  userId: string;
  institutionId: string;
  institutionName: string;
  missingDocuments: string[];
  uploadedDocuments: string[];
  timestamp: Date;
}

export interface IAutoApplyJobPayload {
  applicationId: string;
  userId: string;
  institutionId: string;
}

export interface IProcessApplicationResult {
  applicationId: string;
  previousStatus: ApplicationStatus;
  newStatus: ApplicationStatus;
  missingDocuments?: string[];
  requiredDocuments: string[];
  uploadedDocuments: string[];
  actionTaken: 'AWAITING_USER_INPUT_EMITTED' | 'PUSHED_TO_AUTO_APPLY_QUEUE' | 'NO_OP';
  jobId?: string;
  message?: string;
}

export const GetBlockedApplicationsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export class GetBlockedApplicationsDto {
  page?: number = 1;
  limit?: number = 20;
}

export interface IBlockedApplicationItem {
  id: string;
  status: ApplicationStatus;
  programName: string | null;
  term: string | null;
  submittedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  submissionLogs: any;
  user: {
    id: string;
    name: string | null;
    email: string;
  };
  institution: {
    id: string;
    name: string;
    code: string | null;
    country: string;
  };
}

export interface IPaginatedBlockedApplicationsResponse {
  data: IBlockedApplicationItem[];
  pagination: {
    totalRecords: number;
    page: number;
    limit: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
}

