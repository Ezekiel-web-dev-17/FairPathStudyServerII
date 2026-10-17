import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
  Optional,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  chromium,
  Browser,
  BrowserContext,
  Page,
  errors as playwrightErrors,
} from 'playwright';
import * as cheerio from 'cheerio';
import * as net from 'net';
import * as dns from 'dns';
import { promisify } from 'util';
import { URL } from 'url';
import { PrismaService } from '../prisma/prisma.service.js';
import { AiService, IAiFieldMatch } from '../ai/ai.service.js';
import type { User, StudentProfile, Document } from '@prisma/client';
import {
  IExtractedField,
  IScrapedApplication,
  IAutofillFieldMatch,
  IAutofillResult,
  IInstitutionUpdateJobData,
  IInstitutionScrapedData,
  INewsItem,
} from './scraper.dto.js';

export const INSTITUTION_UPDATES_QUEUE = 'institution-updates';

export class AntiBotChallengeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AntiBotChallengeError';
  }
}

export class ScrapeTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScrapeTimeoutError';
  }
}

const dnsResolve = promisify(dns.resolve4);

@Injectable()
export class ScraperService {
  private readonly logger = new Logger(ScraperService.name);
  private readonly MAX_REDIRECTS = 5;

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiService: AiService,
    @Optional()
    @InjectQueue(INSTITUTION_UPDATES_QUEUE)
    private readonly institutionUpdatesQueue?: Queue<IInstitutionUpdateJobData>,
  ) {}

  /**
   * Safely scrape an application page from a target URL
   */
  async scrapeApplicationPage(url: string): Promise<IScrapedApplication> {
    this.validateUrlForSsrf(url);
    await this.validateResolvedDns(url);

    try {
      this.logger.log(`Fetching application page for scraping: ${url}`);
      const response = await this.fetchWithRedirectValidation(url);

      const contentType = response.headers.get('content-type') || '';
      if (
        !contentType.includes('text/html') &&
        !contentType.includes('application/xhtml+xml')
      ) {
        throw new BadRequestException(
          `Unsupported Content-Type '${contentType}'. Expected HTML page.`,
        );
      }

      // Cap response size to 5MB
      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength > 5 * 1024 * 1024) {
        throw new BadRequestException(
          'Application web page exceeds 5MB size limit.',
        );
      }

      const html = new TextDecoder('utf-8').decode(arrayBuffer);
      return this.parseFormFieldsFromHtml(html, url);
    } catch (error: any) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error(
        `Error scraping page ${url}: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException(`Web scraping failed: ${error.message}`);
    }
  }

  /**
   * Fetch a URL with manual redirect handling — re-validates each redirect target against SSRF rules.
   * Prevents SSRF via open redirects.
   */
  private async fetchWithRedirectValidation(
    url: string,
    redirectCount = 0,
  ): Promise<Response> {
    if (redirectCount > this.MAX_REDIRECTS) {
      throw new BadRequestException(
        `Too many redirects (exceeded ${this.MAX_REDIRECTS}).`,
      );
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'manual',
      headers: {
        'User-Agent': 'FairPathStudyScraper/1.0 (+https://fairpath.study)',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    clearTimeout(timeoutId);

    // Handle redirects manually — re-validate each target
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) {
        throw new BadRequestException(
          'Redirect response missing Location header.',
        );
      }

      const redirectUrl = new URL(location, url).toString();
      this.logger.log(
        `Following redirect (${redirectCount + 1}/${this.MAX_REDIRECTS}): ${redirectUrl}`,
      );
      this.validateUrlForSsrf(redirectUrl);
      await this.validateResolvedDns(redirectUrl);
      return this.fetchWithRedirectValidation(redirectUrl, redirectCount + 1);
    }

    if (!response.ok) {
      throw new BadRequestException(
        `Failed to fetch page. HTTP status: ${response.status} ${response.statusText}`,
      );
    }

    return response;
  }

  /**
   * Parse HTML content to extract form fields, labels, categories, and required document attachments
   */
  parseFormFieldsFromHtml(html: string, pageUrl?: string): IScrapedApplication {
    const $ = cheerio.load(html);

    // 1. Extract Page / Application Title
    const title =
      $('h1').first().text().trim() ||
      $('title').text().trim() ||
      $('meta[property="og:title"]').attr('content')?.trim() ||
      'Student Application Form';

    // 2. Extract Institution Name
    const institutionName =
      $('meta[name="publisher"]').attr('content')?.trim() ||
      $('meta[property="og:site_name"]').attr('content')?.trim() ||
      $('.university-name, .institution-name, .school-header')
        .first()
        .text()
        .trim() ||
      undefined;

    // 3. Extract Application Deadline (supports multiple date formats)
    let deadline: string | undefined;
    const bodyText = $('body').text();

    // First try <time> elements with datetime attributes
    const timeEl = $('time[datetime]').first();
    if (timeEl.length) {
      deadline = timeEl.attr('datetime')?.trim();
    }

    if (!deadline) {
      const deadlinePatterns = [
        // "Deadline: January 15, 2026" or "Due Date: Jan 15, 2026"
        /(?:deadline|due\s*date|application\s+closes|apply\s+by|submissions?\s+due)[:\s]+([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4})/i,
        // "Deadline: 2026-01-15"
        /(?:deadline|due\s*date|application\s+closes|apply\s+by)[:\s]+(\d{4}-\d{2}-\d{2})/i,
        // "Deadline: 15 January 2026"
        /(?:deadline|due\s*date|application\s+closes|apply\s+by)[:\s]+(\d{1,2}\s+[A-Za-z]+\.?,?\s+\d{4})/i,
        // "Deadline: 01/15/2026" or "12-15-2026"
        /(?:deadline|due\s*date|application\s+closes|apply\s+by)[:\s]+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/i,
      ];

      for (const pattern of deadlinePatterns) {
        const match = bodyText.match(pattern);
        if (match) {
          deadline = match[1].trim();
          break;
        }
      }
    }

    // 4. Extract Application Fee (requires "application fee" to avoid false positives like "tuition fee")
    let applicationFee: string | undefined;
    const feeMatch = bodyText.match(
      /(?:application\s+fee|application\s+processing\s+fee)[:\s]+(\$\d+(?:,\d{3})*(?:\.\d{2})?(?:\s*(?:USD|EUR|GBP))?|\d+(?:,\d{3})*(?:\.\d{2})?\s*(?:USD|EUR|GBP))/i,
    );
    if (feeMatch) {
      // Verify this isn't a "no application fee" or "fee waiver" context
      const feeContext = bodyText
        .substring(
          Math.max(0, bodyText.indexOf(feeMatch[0]) - 20),
          bodyText.indexOf(feeMatch[0]) + feeMatch[0].length,
        )
        .toLowerCase();
      if (
        !feeContext.includes('no ') &&
        !feeContext.includes('waiv') &&
        !feeContext.includes('free')
      ) {
        applicationFee = feeMatch[1].trim();
      }
    }

    // 5. Parse Form Fields & Inputs
    const extractedFields: IExtractedField[] = [];
    const processedIds = new Set<string>();

    $('input, select, textarea').each((idx, el) => {
      const $el = $(el);
      const tagName = el.tagName.toLowerCase();
      const typeAttr = ($el.attr('type') || 'text').toLowerCase();

      // Skip hidden, submit, button, reset inputs
      if (['hidden', 'submit', 'button', 'reset', 'image'].includes(typeAttr)) {
        return;
      }

      const name = $el.attr('name') || $el.attr('id') || `field_${idx}`;
      const id = $el.attr('id') || name;

      if (processedIds.has(id)) {
        return;
      }
      processedIds.add(id);

      // Infer Label — escape id for safe CSS selector usage
      let labelText = '';
      const elId = $el.attr('id');
      if (elId) {
        // Escape special CSS characters in the id attribute to prevent selector injection
        const escapedId = elId.replace(
          /([\\!"#$%&'()*+,./:;<=>?@[\]^`{|}~])/g,
          '\\$1',
        );
        labelText = $(`label[for="${escapedId}"]`).text().trim();
      }
      if (!labelText) {
        labelText = $el.closest('label').text().trim();
      }
      if (!labelText) {
        labelText = $el.prev('label').text().trim();
      }
      if (!labelText) {
        labelText =
          $el.attr('placeholder') ||
          $el.attr('aria-label') ||
          $el.attr('title') ||
          name;
      }

      const hasAsterisk = labelText.includes('*');

      // Clean label text
      labelText = labelText.replace(/\s+/g, ' ').replace(/[*:]/g, '').trim();
      if (!labelText) {
        labelText = `Field (${name})`;
      }

      // Detect Required
      const isRequired =
        $el.attr('required') !== undefined ||
        $el.attr('aria-required') === 'true' ||
        $el
          .closest('.form-group, .field, div')
          .find('.required, .asterisk, span:contains("*")').length > 0 ||
        hasAsterisk;

      // Map Type
      let fieldType: IExtractedField['type'] = 'text';
      if (tagName === 'select') fieldType = 'select';
      else if (tagName === 'textarea') fieldType = 'textarea';
      else if (typeAttr === 'email') fieldType = 'email';
      else if (typeAttr === 'number') fieldType = 'number';
      else if (typeAttr === 'date') fieldType = 'date';
      else if (typeAttr === 'file') fieldType = 'file';
      else if (typeAttr === 'checkbox') fieldType = 'checkbox';
      else if (typeAttr === 'radio') fieldType = 'radio';

      // Parse Options for Select
      const options: string[] = [];
      if (tagName === 'select') {
        $el.find('option').each((_, opt) => {
          const val = $(opt).text().trim();
          if (val && !val.toLowerCase().includes('select')) {
            options.push(val);
          }
        });
      }

      // Infer Section
      const section =
        $el
          .closest('fieldset, form, section, .form-section')
          .find('legend, h2, h3, h4')
          .first()
          .text()
          .trim() || undefined;

      // Infer Category
      const inferredCategory = this.categorizeField(name, labelText, typeAttr);

      extractedFields.push({
        id,
        name,
        label: labelText,
        type: fieldType,
        required: isRequired,
        placeholder: $el.attr('placeholder') || undefined,
        options: options.length > 0 ? options : undefined,
        section,
        inferredCategory,
      });
    });

    // 6. Detect Required Documents from Text & Form Uploads
    const requiredDocuments = this.extractRequiredDocuments(
      $,
      bodyText,
      extractedFields,
    );

    return {
      title,
      institutionName,
      deadline,
      applicationFee,
      portalUrl: pageUrl,
      extractedFields,
      requiredDocuments,
      scrapedAt: new Date().toISOString(),
    };
  }

  /**
   * Autofill an application for a specific student using their DB Profile & Documents
   */
  async autofillStudentApplication(
    studentId: string,
    targetUrl?: string,
    rawHtml?: string,
  ): Promise<IAutofillResult> {
    // 1. Fetch Scraped Application Structure
    let scrapedApp: IScrapedApplication;
    if (targetUrl) {
      scrapedApp = await this.scrapeApplicationPage(targetUrl);
    } else if (rawHtml) {
      scrapedApp = this.parseFormFieldsFromHtml(rawHtml);
    } else {
      throw new BadRequestException(
        'Either targetUrl or rawHtml must be provided for autofilling.',
      );
    }

    // 2. Fetch Student Profile and Documents from Prisma
    const student = await this.prisma.user.findUnique({
      where: { id: studentId },
      include: {
        profile: true,
        documents: true,
      },
    });

    if (!student) {
      throw new NotFoundException(
        `Student user with ID '${studentId}' not found.`,
      );
    }

    const profile = student.profile;
    const documents = student.documents || [];

    // Synthesize Student Data Store
    const studentData = this.buildStudentDataStore(student, profile, documents);

    // 3. Perform Field Matching and Autofill Mapping
    //    Try AI-powered semantic matching first; fall back to hardcoded rules
    const fieldMatches = await this.matchFieldsWithAiFallback(
      scrapedApp.extractedFields,
      studentData,
    );

    const totalFieldsCount = scrapedApp.extractedFields.length;
    const filledFieldsCount = fieldMatches.filter((m) => m.isFilled).length;
    const completionPercentage =
      totalFieldsCount > 0
        ? Math.round((filledFieldsCount / totalFieldsCount) * 100)
        : 100;

    const missingRequiredFields = scrapedApp.extractedFields.filter((f) => {
      const match = fieldMatches.find((m) => m.field.id === f.id);
      return f.required && (!match || !match.isFilled);
    });

    // Determine missing document attachments
    const existingDocTypes = documents.map((d) =>
      d.type.toString().toUpperCase(),
    );
    const suggestedDocuments = scrapedApp.requiredDocuments.filter((reqDoc) => {
      const lower = reqDoc.toLowerCase();
      if (lower.includes('passport') && existingDocTypes.includes('PASSPORT'))
        return false;
      if (
        lower.includes('transcript') &&
        existingDocTypes.includes('TRANSCRIPT')
      )
        return false;
      if (
        (lower.includes('toefl') ||
          lower.includes('ielts') ||
          lower.includes('test')) &&
        existingDocTypes.includes('TEST_SCORE')
      )
        return false;
      return true;
    });

    return {
      studentId,
      applicationTitle: scrapedApp.title,
      completionPercentage,
      totalFieldsCount,
      filledFieldsCount,
      missingRequiredFields,
      suggestedDocuments,
      fieldMatches,
      scrapedApplication: scrapedApp,
    };
  }
  /**
   * Save autofilled application data into student's unified profile in DB
   */
  async saveAutofilledApplication(studentId: string, applicationData: any) {
    const student = await this.prisma.user.findUnique({
      where: { id: studentId },
      include: { profile: true },
    });

    if (!student) {
      throw new NotFoundException(`Student with ID '${studentId}' not found.`);
    }

    let existingProfile = student.profile;
    const currentUnified =
      (existingProfile?.unifiedProfile as Record<string, any>) || {};

    const updatedUnified = {
      ...currentUnified,
      lastAutofilledApplication: {
        savedAt: new Date().toISOString(),
        applicationData,
      },
    };

    if (existingProfile) {
      return this.prisma.studentProfile.update({
        where: { studentId },
        data: {
          unifiedProfile: updatedUnified,
        },
      });
    } else {
      return this.prisma.studentProfile.create({
        data: {
          studentId,
          unifiedProfile: updatedUnified,
        },
      });
    }
  }

  /**
   * Categorize a form field based on label and input metadata
   */
  private categorizeField(
    name: string,
    label: string,
    type: string,
  ): IExtractedField['inferredCategory'] {
    const text = `${name} ${label}`.toLowerCase();

    // 1. Document uploads — highest priority, unambiguous
    if (
      type === 'file' ||
      text.includes('upload') ||
      text.includes('attachment')
    ) {
      return 'DOCUMENT_UPLOAD';
    }

    // 2. Test scores — check before academic to catch "TOEFL", "GRE" etc.
    if (
      text.includes('toefl') ||
      text.includes('ielts') ||
      text.includes('gre') ||
      text.includes('sat') ||
      text.includes('gmat') ||
      text.includes('test score')
    ) {
      return 'TEST_SCORES';
    }

    // 3. Passport / identity — check before personal info since "nationality" could overlap
    if (
      text.includes('passport') ||
      text.includes('national id') ||
      text.includes('citizenship')
    ) {
      return 'PASSPORT';
    }

    // 4. Academic — check before personal info since "university name", "school name" would false-match on "name"
    if (
      text.includes('gpa') ||
      text.includes('degree') ||
      text.includes('major') ||
      text.includes('transcript') ||
      text.includes('university') ||
      text.includes('school') ||
      text.includes('graduation') ||
      text.includes('institution') ||
      text.includes('college') ||
      text.includes('program name') ||
      text.includes('course name') ||
      text.includes('field of study') ||
      text.includes('specialization') ||
      text.includes('country of study')
    ) {
      return 'ACADEMIC';
    }

    // 5. Personal info — broadest category, checked last to avoid false positives
    if (
      text.includes('first name') ||
      text.includes('last name') ||
      text.includes('full name') ||
      text.includes('given name') ||
      text.includes('family name') ||
      text.includes('surname') ||
      text.includes('applicant name') ||
      text.includes('email') ||
      text.includes('phone') ||
      text.includes('address') ||
      text.includes('birth') ||
      text.includes('gender') ||
      text.includes('city') ||
      text.includes('nationality') ||
      // Only match bare "name" if it's not qualified by academic/institutional context
      (text.includes('name') &&
        !text.includes('program') &&
        !text.includes('course') &&
        !text.includes('university') &&
        !text.includes('school') &&
        !text.includes('institution') &&
        !text.includes('college') &&
        !text.includes('document'))
    ) {
      return 'PERSONAL_INFO';
    }

    return 'MISC';
  }

  /**
   * Extract required document list from text and file inputs
   */
  private extractRequiredDocuments(
    $: cheerio.CheerioAPI,
    bodyText: string,
    fields: IExtractedField[],
  ): string[] {
    const docs = new Set<string>();

    // From file inputs
    fields
      .filter((f) => f.type === 'file')
      .forEach((f) => {
        docs.add(f.label);
      });

    // From page text rules — comprehensive list of common application documents
    const docKeywords = [
      'Official Transcript',
      'Unofficial Transcript',
      'Passport Copy',
      'TOEFL Score Report',
      'IELTS Score Report',
      'GRE Score Report',
      'GMAT Score Report',
      'SAT Score Report',
      'Statement of Purpose',
      'Personal Statement',
      'Letter of Recommendation',
      'Resume',
      'Curriculum Vitae',
      'CV',
      'Portfolio',
      'Writing Sample',
      'Financial Statement',
      'Bank Statement',
      'Proof of Funds',
      'Affidavit of Support',
      'Health Insurance',
      'Immunization Record',
      'Vaccination Record',
      'Research Proposal',
      'Certificate of Eligibility',
    ];

    docKeywords.forEach((kw) => {
      if (
        new RegExp(
          `\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
          'i',
        ).test(bodyText)
      ) {
        docs.add(kw);
      }
    });

    return Array.from(docs);
  }

  /**
   * Build a unified lookup dictionary from Student User, Profile, and Documents
   */
  private buildStudentDataStore(
    user: User,
    profile: StudentProfile | null,
    documents: Document[],
  ) {
    const passportDetails =
      (profile?.passportDetails as Record<string, any>) || {};
    const academicHistory =
      (profile?.academicHistory as Record<string, any>) || {};
    const testScores = (profile?.testScores as Record<string, any>) || {};
    const unified = (profile?.unifiedProfile as Record<string, any>) || {};

    const nameParts = (user.name || '').split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    return {
      email: user.email,
      name: user.name,
      firstName,
      lastName,
      passportNumber:
        passportDetails.passportNumber ||
        passportDetails.number ||
        unified.passportNumber,
      nationality:
        passportDetails.nationality ||
        passportDetails.country ||
        unified.nationality,
      dateOfBirth:
        passportDetails.dateOfBirth ||
        passportDetails.dob ||
        unified.dateOfBirth,
      gpa: academicHistory.gpa || academicHistory.cumulativeGpa || unified.gpa,
      degree:
        academicHistory.degree || academicHistory.degreeName || unified.degree,
      institution:
        academicHistory.institution ||
        academicHistory.university ||
        unified.institution,
      major:
        academicHistory.major || academicHistory.fieldOfStudy || unified.major,
      toeflScore: testScores.toefl || testScores.toeflIbt || unified.toeflScore,
      ieltsScore: testScores.ielts || unified.ieltsScore,
      greScore: testScores.gre || unified.greScore,
      documents: documents.map((d) => ({
        id: d.id,
        fileName: d.fileName,
        fileUrl: d.fileUrl,
        type: d.type,
      })),
    };
  }

  /**
   * Try AI-powered field matching first, then fall back to hardcoded rules.
   * If AI returns results, we merge them with the hardcoded fallback for any
   * fields the AI didn't match (confidence 0 or missing).
   */
  private async matchFieldsWithAiFallback(
    fields: IExtractedField[],
    studentData: Record<string, unknown>,
  ): Promise<IAutofillFieldMatch[]> {
    // Attempt AI matching
    let aiMatches: IAiFieldMatch[] | null = null;
    if (this.aiService.isEnabled) {
      this.logger.log('Attempting AI-powered field matching...');
      const fieldSummaries = fields.map((f) => ({
        id: f.id,
        name: f.name,
        label: f.label,
        type: f.type,
      }));
      aiMatches = await this.aiService.matchFieldsToStudentData(
        fieldSummaries,
        studentData,
      );
      if (aiMatches) {
        this.logger.log(
          `AI matched ${aiMatches.filter((m) => m.confidence > 0).length}/${fields.length} fields.`,
        );
      }
    }

    // Build a lookup map from AI results
    const aiMatchMap = new Map<string, IAiFieldMatch>();
    if (aiMatches) {
      for (const m of aiMatches) {
        aiMatchMap.set(m.fieldId, m);
      }
    }

    // For each field: use AI result if confident, otherwise fall back to hardcoded
    return fields.map((field) => {
      const aiResult = aiMatchMap.get(field.id);

      if (
        aiResult &&
        aiResult.confidence >= 0.7 &&
        aiResult.suggestedValue != null
      ) {
        return {
          field,
          autofilledValue: aiResult.suggestedValue,
          isFilled: true,
          source: aiResult.source,
          confidence: aiResult.confidence,
        };
      }

      // Fall back to hardcoded matching
      return this.matchFieldToStudentData(
        field,
        studentData as Record<string, any>,
      );
    });
  }

  /**
   * Hardcoded fallback: match an extracted application field against student data
   */
  private matchFieldToStudentData(
    field: IExtractedField,
    data: Record<string, any>,
  ): IAutofillFieldMatch {
    const text = `${field.name} ${field.label}`.toLowerCase();

    // 1. Personal Details Matching
    if (text.includes('first name') || text.includes('given name')) {
      return this.createMatch(field, data.firstName, 'USER_PROFILE', 0.95);
    }
    if (
      text.includes('last name') ||
      text.includes('family name') ||
      text.includes('surname')
    ) {
      return this.createMatch(field, data.lastName, 'USER_PROFILE', 0.95);
    }
    if (text.includes('email')) {
      return this.createMatch(field, data.email, 'USER_PROFILE', 1.0);
    }
    if (
      text.includes('full name') ||
      text.includes('applicant name') ||
      (text.includes('name') &&
        !text.includes('school') &&
        !text.includes('first') &&
        !text.includes('last') &&
        !text.includes('university') &&
        !text.includes('institution') &&
        !text.includes('program') &&
        !text.includes('course') &&
        !text.includes('college'))
    ) {
      return this.createMatch(field, data.name, 'USER_PROFILE', 0.9);
    }

    // 2. Passport Matching
    if (
      text.includes('passport number') ||
      text.includes('passport no') ||
      text.includes('document id')
    ) {
      return this.createMatch(field, data.passportNumber, 'PASSPORT', 0.95);
    }
    if (
      text.includes('nationality') ||
      text.includes('citizenship') ||
      text.includes('country of origin')
    ) {
      return this.createMatch(field, data.nationality, 'PASSPORT', 0.9);
    }
    if (
      text.includes('date of birth') ||
      text.includes('dob') ||
      text.includes('birth date')
    ) {
      return this.createMatch(field, data.dateOfBirth, 'PASSPORT', 0.9);
    }

    // 3. Academic History Matching
    if (
      text.includes('gpa') ||
      text.includes('grade point average') ||
      text.includes('cumulative grade')
    ) {
      return this.createMatch(field, data.gpa, 'ACADEMIC', 0.95);
    }
    if (text.includes('degree') || text.includes('qualification')) {
      return this.createMatch(field, data.degree, 'ACADEMIC', 0.9);
    }
    if (
      text.includes('university') ||
      text.includes('institution') ||
      text.includes('college name') ||
      text.includes('school name')
    ) {
      return this.createMatch(field, data.institution, 'ACADEMIC', 0.9);
    }
    if (
      text.includes('major') ||
      text.includes('field of study') ||
      text.includes('specialization')
    ) {
      return this.createMatch(field, data.major, 'ACADEMIC', 0.9);
    }

    // 4. Test Scores Matching
    if (text.includes('toefl')) {
      return this.createMatch(field, data.toeflScore, 'TEST_SCORES', 0.95);
    }
    if (text.includes('ielts')) {
      return this.createMatch(field, data.ieltsScore, 'TEST_SCORES', 0.95);
    }
    if (text.includes('gre')) {
      return this.createMatch(field, data.greScore, 'TEST_SCORES', 0.95);
    }

    // 5. File Uploads Matching
    if (field.type === 'file') {
      if (text.includes('passport')) {
        const passportDoc = data.documents.find(
          (d: any) => d.type === 'PASSPORT',
        );
        return this.createMatch(
          field,
          passportDoc ? passportDoc.fileUrl : null,
          'DOCUMENTS',
          0.9,
        );
      }
      if (text.includes('transcript')) {
        const transcriptDoc = data.documents.find(
          (d: any) => d.type === 'TRANSCRIPT',
        );
        return this.createMatch(
          field,
          transcriptDoc ? transcriptDoc.fileUrl : null,
          'DOCUMENTS',
          0.9,
        );
      }
      if (
        text.includes('test') ||
        text.includes('score') ||
        text.includes('toefl') ||
        text.includes('ielts')
      ) {
        const testDoc = data.documents.find(
          (d: any) => d.type === 'TEST_SCORE',
        );
        return this.createMatch(
          field,
          testDoc ? testDoc.fileUrl : null,
          'DOCUMENTS',
          0.9,
        );
      }
    }

    return {
      field,
      autofilledValue: null,
      isFilled: false,
      source: 'NONE',
      confidence: 0,
    };
  }

  private createMatch(
    field: IExtractedField,
    value: any,
    source: IAutofillFieldMatch['source'],
    confidence: number,
  ): IAutofillFieldMatch {
    const isFilled = value !== undefined && value !== null && value !== '';
    return {
      field,
      autofilledValue: isFilled ? value : null,
      isFilled,
      source: isFilled ? source : 'NONE',
      confidence: isFilled ? confidence : 0,
    };
  }

  /**
   * SSRF Protection: Validate target URL against dangerous protocols and private IP ranges
   */
  private validateUrlForSsrf(urlString: string) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(urlString);
    } catch {
      throw new BadRequestException('Invalid URL format provided.');
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new BadRequestException(
        `Forbidden protocol '${parsedUrl.protocol}'. Only http and https URLs are allowed.`,
      );
    }

    const hostname = parsedUrl.hostname.toLowerCase();

    // Block localhost and standard loopback hostnames
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname === '::1' ||
      hostname === '[::1]' ||
      hostname === '169.254.169.254' || // AWS IMDS
      hostname === '169.254.170.2' || // AWS ECS Task Metadata
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.amazonaws.com') // Block direct AWS metadata via custom DNS
    ) {
      throw new BadRequestException(
        'Access to localhost or private network hostnames is blocked for security (SSRF Protection).',
      );
    }

    // Check IP addresses if literal IP is passed
    if (net.isIP(hostname)) {
      if (this.isPrivateIp(hostname)) {
        throw new BadRequestException(
          'Access to private IP address ranges is blocked for security (SSRF Protection).',
        );
      }
    }
  }

  /**
   * DNS Rebinding Protection: Resolve hostname DNS and validate the resolved IPs
   * before fetch uses its own resolution. Prevents attackers from providing a domain
   * that initially resolves to a public IP but rebinds to a private IP.
   */
  private async validateResolvedDns(urlString: string) {
    const parsedUrl = new URL(urlString);
    const hostname = parsedUrl.hostname;

    // Skip validation for literal IP addresses — already checked in validateUrlForSsrf
    if (net.isIP(hostname)) {
      return;
    }

    try {
      const addresses = await dnsResolve(hostname);
      for (const ip of addresses) {
        if (this.isPrivateIp(ip)) {
          this.logger.warn(
            `DNS rebinding attempt detected: ${hostname} resolved to private IP ${ip}`,
          );
          throw new BadRequestException(
            `DNS for '${hostname}' resolves to a private IP address. Request blocked for security (SSRF Protection).`,
          );
        }
      }
    } catch (error: any) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.warn(
        `DNS resolution failed for ${hostname}: ${error.message}`,
      );
      throw new BadRequestException(
        `Could not resolve hostname '${hostname}'. Ensure the URL is reachable.`,
      );
    }
  }

  private isPrivateIp(ip: string): boolean {
    // IPv4 private/reserved ranges
    if (
      ip.startsWith('127.') ||
      ip.startsWith('10.') ||
      ip.startsWith('169.254.')
    ) {
      return true;
    }
    if (ip.startsWith('192.168.')) {
      return true;
    }
    if (ip.startsWith('172.')) {
      const secondOctet = parseInt(ip.split('.')[1], 10);
      if (secondOctet >= 16 && secondOctet <= 31) {
        return true;
      }
    }
    // 0.0.0.0/8 — "this" network
    if (ip.startsWith('0.')) {
      return true;
    }
    return false;
  }

  /**
   * Queue a university URL for asynchronous Playwright scraping and updates
   */
  async queueInstitutionUpdate(
    universityUrl: string,
    institutionId?: string,
  ): Promise<{ jobId: string; status: string; message: string }> {
    if (!this.institutionUpdatesQueue) {
      throw new BadRequestException('Institution updates queue is not configured.');
    }

    this.validateUrlForSsrf(universityUrl);
    await this.validateResolvedDns(universityUrl);

    const job = await this.institutionUpdatesQueue.add(
      'scrape-institution',
      {
        universityUrl,
        institutionId,
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
      `Enqueued institution update job [ID: ${job.id}] for URL: ${universityUrl}`,
    );

    return {
      jobId: job.id as string,
      status: 'QUEUED',
      message: `Institution update job successfully queued for ${universityUrl}.`,
    };
  }

  /**
   * Directly scrape a university website using Playwright, extracting Application Deadline,
   * Estimated Tuition, and Newsletter/Recent News.
   * Detects timeouts and anti-bot challenge pages (Cloudflare Turnstile, captchas, etc.).
   */
  async scrapeWithPlaywright(universityUrl: string): Promise<IInstitutionScrapedData> {
    this.validateUrlForSsrf(universityUrl);
    await this.validateResolvedDns(universityUrl);

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let page: Page | null = null;

    try {
      this.logger.log(
        `Launching headless Playwright browser to scrape: ${universityUrl}`,
      );
      browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
        ],
      });

      context = await browser.newContext({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 800 },
        locale: 'en-US',
      });

      // Evade simple automated webdriver detection
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined,
        });
      });

      page = await context.newPage();
      page.setDefaultNavigationTimeout(30000);
      page.setDefaultTimeout(15000);

      this.logger.log(`Navigating to ${universityUrl}...`);
      let response;
      try {
        response = await page.goto(universityUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
      } catch (err: any) {
        if (
          err instanceof playwrightErrors.TimeoutError ||
          err.name === 'TimeoutError' ||
          err.message?.includes('Timeout') ||
          err.message?.includes('timed out')
        ) {
          throw new ScrapeTimeoutError(
            `Navigation timed out after 30s while reaching: ${universityUrl}`,
          );
        }
        throw err;
      }

      const status = response ? response.status() : 200;

      // 1. Check for Anti-Bot & Cloudflare challenges immediately upon DOM load
      await this.checkForAntiBot(page, status);

      // 2. Allow dynamic content & hydration to settle
      await page.waitForLoadState('networkidle').catch(() => {
        this.logger.debug(
          'Network idle timeout reached, proceeding with loaded DOM content.',
        );
      });

      // 3. Check for Anti-Bot & Cloudflare challenges post-hydration
      await this.checkForAntiBot(page, status);

      const pageTitle = await page.title().catch(() => '');

      // 4. Extract required study-abroad fields
      const applicationDeadline = await this.extractApplicationDeadline(page);
      const estimatedTuition = await this.extractEstimatedTuition(page);
      const recentNews = await this.extractRecentNews(page, universityUrl);

      return {
        universityUrl,
        pageTitle,
        applicationDeadline,
        estimatedTuition,
        recentNews,
        scrapedAt: new Date().toISOString(),
      };
    } finally {
      if (page) await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
    }
  }

  /**
   * Anti-bot page detection (Cloudflare Turnstile, verification challenges, 403/503 gates)
   */
  private async checkForAntiBot(page: Page, responseStatus?: number): Promise<void> {
    const title = (await page.title().catch(() => '')).toLowerCase();

    // 1. Status code check (Cloudflare 403 / 503)
    if (responseStatus === 403 || responseStatus === 503) {
      if (
        title.includes('cloudflare') ||
        title.includes('just a moment') ||
        title.includes('attention required') ||
        title.includes('security check')
      ) {
        throw new AntiBotChallengeError(
          `Anti-bot challenge page detected (HTTP ${responseStatus} with title "${title}")`,
        );
      }
    }

    // 2. Known challenge page titles
    const challengeTitles = [
      'just a moment...',
      'attention required! | cloudflare',
      'security check',
      'access denied',
      'ddos-guard',
      'bot verification',
      'are you a human',
      'turnstile',
    ];
    if (challengeTitles.some((t) => title.includes(t))) {
      throw new AntiBotChallengeError(
        `Anti-bot challenge page detected by title: "${title}"`,
      );
    }

    // 3. Known challenge DOM elements (Cloudflare Turnstile, captcha, challenge forms)
    const challengeSelectors = [
      '#challenge-running',
      '#cf-challenge-running',
      '.cf-browser-verification',
      '#challenge-form',
      '#challenge-stage',
      'iframe[src*="cloudflare"]',
      'iframe[src*="challenges.cloudflare.com"]',
      'div[id*="turnstile"]',
      'div[class*="cf-turnstile"]',
      '#cf-wrapper',
      '.cf-error-overview',
    ];

    for (const selector of challengeSelectors) {
      const el = await page.$(selector).catch(() => null);
      if (el) {
        throw new AntiBotChallengeError(
          `Anti-bot challenge element detected: "${selector}"`,
        );
      }
    }

    // 4. Body text heuristics
    const bodySnippet = await page
      .evaluate(() => {
        return document.body
          ? document.body.innerText.slice(0, 1500).toLowerCase()
          : '';
      })
      .catch(() => '');

    const challengePhrases = [
      'checking your browser before accessing',
      'verify you are human',
      'enable javascript and cookies to continue',
      'ray id:',
      'performance & security by cloudflare',
      'please wait while we verify',
      'verifying you are human',
    ];

    for (const phrase of challengePhrases) {
      if (bodySnippet.includes(phrase)) {
        throw new AntiBotChallengeError(
          `Anti-bot challenge text detected: "${phrase}"`,
        );
      }
    }
  }

  /**
   * Extract Application Deadline from DOM or text heuristics
   */
  private async extractApplicationDeadline(page: Page): Promise<string | null> {
    try {
      const deadline = await page.evaluate(() => {
        // Check elements with specific deadline attributes or classes
        const deadlineSelectors = [
          '[class*="deadline" i]',
          '[id*="deadline" i]',
          '[data-testid*="deadline" i]',
          '[class*="apply-by" i]',
          '[id*="apply-by" i]',
          '[class*="important-dates" i]',
          '[class*="key-dates" i]',
        ];

        for (const selector of deadlineSelectors) {
          const elements = document.querySelectorAll(selector);
          for (const el of Array.from(elements)) {
            const text = (el as HTMLElement).innerText?.trim();
            if (text && text.length > 3 && text.length < 250) {
              return text;
            }
          }
        }

        // Scan paragraphs, lists, table cells for deadline patterns
        const textElements = document.querySelectorAll('p, li, td, th, dd, div');
        const deadlineRegex =
          /(?:application\s+deadline|admission\s+deadline|apply\s+by|priority\s+deadline|final\s+deadline)[:\s]+([^.\n\r]{3,80})/i;

        for (const el of Array.from(textElements)) {
          const text = (el as HTMLElement).innerText?.trim() || '';
          const match = text.match(deadlineRegex);
          if (match && match[0]) {
            return match[0].trim();
          }
        }

        return null;
      });

      return deadline || null;
    } catch {
      return null;
    }
  }

  /**
   * Extract Estimated Tuition & Fees
   */
  private async extractEstimatedTuition(page: Page): Promise<string | null> {
    try {
      const tuition = await page.evaluate(() => {
        // Check elements with tuition / fees selectors
        const tuitionSelectors = [
          '[class*="tuition" i]',
          '[id*="tuition" i]',
          '[data-testid*="tuition" i]',
          '[class*="cost-of-attendance" i]',
          '[class*="fees" i]',
        ];

        for (const selector of tuitionSelectors) {
          const elements = document.querySelectorAll(selector);
          for (const el of Array.from(elements)) {
            const text = (el as HTMLElement).innerText?.trim();
            if (
              text &&
              (text.includes('$') ||
                text.includes('£') ||
                text.includes('€') ||
                /tuition/i.test(text))
            ) {
              if (text.length > 3 && text.length < 250) {
                return text;
              }
            }
          }
        }

        // Scan page text for currency and tuition keywords
        const textElements = document.querySelectorAll('p, li, td, th, dd, div');
        const tuitionRegex =
          /(?:estimated\s+tuition|annual\s+tuition|tuition(?:\s+and\s+fees)?|cost\s+of\s+attendance)[:\s]+([^.\n\r]{3,80})/i;

        for (const el of Array.from(textElements)) {
          const text = (el as HTMLElement).innerText?.trim() || '';
          const match = text.match(tuitionRegex);
          if (match && match[0]) {
            return match[0].trim();
          }
        }

        return null;
      });

      return tuition || null;
    } catch {
      return null;
    }
  }

  /**
   * Extract Newsletter / Recent News items
   */
  private async extractRecentNews(
    page: Page,
    baseUrl: string,
  ): Promise<INewsItem[]> {
    try {
      const news = await page.evaluate((base) => {
        const items: Array<{
          title: string;
          link?: string;
          date?: string;
          snippet?: string;
        }> = [];

        // Look for articles or news containers
        const containers = document.querySelectorAll(
          'article, .news-item, .post, [class*="news" i], [class*="press-release" i], [class*="announcement" i], [id*="news" i]',
        );

        for (const el of Array.from(containers)) {
          if (items.length >= 10) break;

          const titleEl = el.querySelector(
            'h1, h2, h3, h4, h5, a, [class*="title" i]',
          );
          const title = titleEl ? (titleEl as HTMLElement).innerText?.trim() : '';

          if (!title || title.length < 5 || title.length > 300) continue;

          // Avoid duplicate titles
          if (items.some((i) => i.title.toLowerCase() === title.toLowerCase()))
            continue;

          const anchor =
            el.querySelector('a') ||
            (el.tagName === 'A' ? (el as HTMLAnchorElement) : null);
          let link: string | undefined = undefined;
          if (anchor && anchor.getAttribute('href')) {
            try {
              link = new URL(anchor.getAttribute('href')!, base).href;
            } catch {
              link = anchor.getAttribute('href') || undefined;
            }
          }

          const timeEl = el.querySelector(
            'time, [class*="date" i], [class*="time" i]',
          );
          const date = timeEl
            ? (timeEl as HTMLElement).innerText?.trim()
            : undefined;

          const snippetEl = el.querySelector(
            'p, [class*="summary" i], [class*="excerpt" i], [class*="snippet" i]',
          );
          const snippet =
            snippetEl && snippetEl !== titleEl
              ? (snippetEl as HTMLElement).innerText?.trim()
              : undefined;

          items.push({
            title,
            link,
            date,
            snippet: snippet ? snippet.slice(0, 300) : undefined,
          });
        }

        // Fallback: prominent news links if no structured containers found
        if (items.length === 0) {
          const links = document.querySelectorAll(
            'a[href*="news" i], a[href*="press" i], a[href*="article" i]',
          );
          for (const a of Array.from(links)) {
            if (items.length >= 5) break;
            const text = (a as HTMLElement).innerText?.trim();
            const href = (a as HTMLAnchorElement).getAttribute('href');
            if (text && text.length > 10 && text.length < 150 && href) {
              try {
                const fullUrl = new URL(href, base).href;
                if (!items.some((i) => i.title === text)) {
                  items.push({ title: text, link: fullUrl });
                }
              } catch {}
            }
          }
        }

        return items;
      }, baseUrl);

      return news || [];
    } catch {
      return [];
    }
  }
}
