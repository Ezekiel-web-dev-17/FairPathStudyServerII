import { z } from 'zod';

export const ScrapeUrlSchema = z.object({
  url: z.string().url({ message: 'Invalid URL provided.' }),
});

export class ScrapeUrlDto {
  url!: string;
}

export const ParseHtmlSchema = z.object({
  html: z.string().min(1, { message: 'HTML content cannot be empty.' }),
  url: z.string().url().optional(),
});

export class ParseHtmlDto {
  html!: string;
  url?: string;
}

export const AutofillApplicationSchema = z.object({
  studentId: z.string().min(1, { message: 'Student ID must be a non-empty string.' }),
  targetUrl: z.string().url().optional(),
  rawHtml: z.string().optional(),
}).refine((data) => data.targetUrl || data.rawHtml, {
  message: 'Either targetUrl or rawHtml must be provided.',
});

export class AutofillApplicationDto {
  studentId!: string;
  targetUrl?: string;
  rawHtml?: string;
}

export const SaveApplicationSchema = z.object({
  studentId: z.string().min(1),
  applicationName: z.string().optional(),
  applicationData: z.record(z.string(), z.any()),
});

export class SaveApplicationDto {
  studentId!: string;
  applicationName?: string;
  applicationData!: Record<string, any>;
}

export interface IExtractedField {
  id: string;
  name: string;
  label: string;
  type: 'text' | 'email' | 'number' | 'date' | 'file' | 'select' | 'textarea' | 'checkbox' | 'radio' | 'other';
  required: boolean;
  placeholder?: string;
  options?: string[];
  section?: string;
  inferredCategory: 'PERSONAL_INFO' | 'PASSPORT' | 'ACADEMIC' | 'TEST_SCORES' | 'DOCUMENT_UPLOAD' | 'MISC';
}

export interface IScrapedApplication {
  title: string;
  institutionName?: string;
  deadline?: string;
  applicationFee?: string;
  portalUrl?: string;
  extractedFields: IExtractedField[];
  requiredDocuments: string[];
  scrapedAt: string;
}

export interface IAutofillFieldMatch {
  field: IExtractedField;
  autofilledValue: any;
  isFilled: boolean;
  source: 'USER_PROFILE' | 'PASSPORT' | 'ACADEMIC' | 'TEST_SCORES' | 'DOCUMENTS' | 'NONE';
  confidence: number;
}

export interface IAutofillResult {
  studentId: string;
  applicationTitle: string;
  completionPercentage: number;
  totalFieldsCount: number;
  filledFieldsCount: number;
  missingRequiredFields: IExtractedField[];
  suggestedDocuments: string[];
  fieldMatches: IAutofillFieldMatch[];
  scrapedApplication: IScrapedApplication;
}
