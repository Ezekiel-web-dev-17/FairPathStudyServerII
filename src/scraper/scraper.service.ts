import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import * as net from 'net';
import * as dns from 'dns';
import { promisify } from 'util';
import { URL } from 'url';
import { PrismaService } from '../prisma/prisma.service.js';
import type { User, StudentProfile, Document } from '@prisma/client';
import {
  IExtractedField,
  IScrapedApplication,
  IAutofillFieldMatch,
  IAutofillResult,
} from './scraper.dto.js';

const dnsResolve = promisify(dns.resolve4);

@Injectable()
export class ScraperService {
  private readonly logger = new Logger(ScraperService.name);
  private readonly MAX_REDIRECTS = 5;

  constructor(private readonly prisma: PrismaService) {}

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
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
        throw new BadRequestException(`Unsupported Content-Type '${contentType}'. Expected HTML page.`);
      }

      // Cap response size to 5MB
      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength > 5 * 1024 * 1024) {
        throw new BadRequestException('Application web page exceeds 5MB size limit.');
      }

      const html = new TextDecoder('utf-8').decode(arrayBuffer);
      return this.parseFormFieldsFromHtml(html, url);
    } catch (error: any) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error(`Error scraping page ${url}: ${error.message}`, error.stack);
      throw new BadRequestException(`Web scraping failed: ${error.message}`);
    }
  }

  /**
   * Fetch a URL with manual redirect handling — re-validates each redirect target against SSRF rules.
   * Prevents SSRF via open redirects.
   */
  private async fetchWithRedirectValidation(url: string, redirectCount = 0): Promise<Response> {
    if (redirectCount > this.MAX_REDIRECTS) {
      throw new BadRequestException(`Too many redirects (exceeded ${this.MAX_REDIRECTS}).`);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'manual',
      headers: {
        'User-Agent': 'FairPathStudyScraper/1.0 (+https://fairpath.study)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    clearTimeout(timeoutId);

    // Handle redirects manually — re-validate each target
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) {
        throw new BadRequestException('Redirect response missing Location header.');
      }

      const redirectUrl = new URL(location, url).toString();
      this.logger.log(`Following redirect (${redirectCount + 1}/${this.MAX_REDIRECTS}): ${redirectUrl}`);
      this.validateUrlForSsrf(redirectUrl);
      await this.validateResolvedDns(redirectUrl);
      return this.fetchWithRedirectValidation(redirectUrl, redirectCount + 1);
    }

    if (!response.ok) {
      throw new BadRequestException(`Failed to fetch page. HTTP status: ${response.status} ${response.statusText}`);
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
      $('.university-name, .institution-name, .school-header').first().text().trim() ||
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
      /(?:application\s+fee|application\s+processing\s+fee)[:\s]+(\$\d+(?:,\d{3})*(?:\.\d{2})?(?:\s*(?:USD|EUR|GBP))?|\d+(?:,\d{3})*(?:\.\d{2})?\s*(?:USD|EUR|GBP))/i
    );
    if (feeMatch) {
      // Verify this isn't a "no application fee" or "fee waiver" context
      const feeContext = bodyText.substring(
        Math.max(0, bodyText.indexOf(feeMatch[0]) - 20),
        bodyText.indexOf(feeMatch[0]) + feeMatch[0].length,
      ).toLowerCase();
      if (!feeContext.includes('no ') && !feeContext.includes('waiv') && !feeContext.includes('free')) {
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
        const escapedId = elId.replace(/([\\!"#$%&'()*+,./:;<=>?@[\]^`{|}~])/g, '\\$1');
        labelText = $(`label[for="${escapedId}"]`).text().trim();
      }
      if (!labelText) {
        labelText = $el.closest('label').text().trim();
      }
      if (!labelText) {
        labelText = $el.prev('label').text().trim();
      }
      if (!labelText) {
        labelText = $el.attr('placeholder') || $el.attr('aria-label') || $el.attr('title') || name;
      }

      // Clean label text
      labelText = labelText.replace(/\s+/g, ' ').replace(/[*:]/g, '').trim();
      if (!labelText) {
        labelText = `Field (${name})`;
      }

      // Detect Required
      const isRequired =
        $el.attr('required') !== undefined ||
        $el.attr('aria-required') === 'true' ||
        $el.closest('.form-group, .field, div').find('.required, .asterisk, span:contains("*")').length > 0 ||
        labelText.includes('*');

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
      const section = $el.closest('fieldset, form, section, .form-section').find('legend, h2, h3, h4').first().text().trim() || undefined;

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
    const requiredDocuments = this.extractRequiredDocuments($, bodyText, extractedFields);

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
      throw new BadRequestException('Either targetUrl or rawHtml must be provided for autofilling.');
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
      throw new NotFoundException(`Student user with ID '${studentId}' not found.`);
    }

    const profile = student.profile;
    const documents = student.documents || [];

    // Synthesize Student Data Store
    const studentData = this.buildStudentDataStore(student, profile, documents);

    // 3. Perform Field Matching and Autofill Mapping
    const fieldMatches: IAutofillFieldMatch[] = scrapedApp.extractedFields.map((field) => {
      return this.matchFieldToStudentData(field, studentData);
    });

    const totalFieldsCount = scrapedApp.extractedFields.length;
    const filledFieldsCount = fieldMatches.filter((m) => m.isFilled).length;
    const completionPercentage = totalFieldsCount > 0 ? Math.round((filledFieldsCount / totalFieldsCount) * 100) : 100;

    const missingRequiredFields = scrapedApp.extractedFields.filter((f) => {
      const match = fieldMatches.find((m) => m.field.id === f.id);
      return f.required && (!match || !match.isFilled);
    });

    // Determine missing document attachments
    const existingDocTypes = documents.map((d) => d.type.toString().toUpperCase());
    const suggestedDocuments = scrapedApp.requiredDocuments.filter((reqDoc) => {
      const lower = reqDoc.toLowerCase();
      if (lower.includes('passport') && existingDocTypes.includes('PASSPORT')) return false;
      if (lower.includes('transcript') && existingDocTypes.includes('TRANSCRIPT')) return false;
      if ((lower.includes('toefl') || lower.includes('ielts') || lower.includes('test')) && existingDocTypes.includes('TEST_SCORE')) return false;
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
    const currentUnified = (existingProfile?.unifiedProfile as Record<string, any>) || {};

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
  private categorizeField(name: string, label: string, type: string): IExtractedField['inferredCategory'] {
    const text = `${name} ${label}`.toLowerCase();

    // 1. Document uploads — highest priority, unambiguous
    if (type === 'file' || text.includes('upload') || text.includes('attachment')) {
      return 'DOCUMENT_UPLOAD';
    }

    // 2. Test scores — check before academic to catch "TOEFL", "GRE" etc.
    if (text.includes('toefl') || text.includes('ielts') || text.includes('gre') || text.includes('sat') || text.includes('gmat') || text.includes('test score')) {
      return 'TEST_SCORES';
    }

    // 3. Passport / identity — check before personal info since "nationality" could overlap
    if (text.includes('passport') || text.includes('national id') || text.includes('citizenship')) {
      return 'PASSPORT';
    }

    // 4. Academic — check before personal info since "university name", "school name" would false-match on "name"
    if (text.includes('gpa') || text.includes('degree') || text.includes('major') || text.includes('transcript') ||
        text.includes('university') || text.includes('school') || text.includes('graduation') ||
        text.includes('institution') || text.includes('college') || text.includes('program name') ||
        text.includes('course name') || text.includes('field of study') || text.includes('specialization') ||
        text.includes('country of study')) {
      return 'ACADEMIC';
    }

    // 5. Personal info — broadest category, checked last to avoid false positives
    if (text.includes('first name') || text.includes('last name') || text.includes('full name') ||
        text.includes('given name') || text.includes('family name') || text.includes('surname') ||
        text.includes('applicant name') || text.includes('email') || text.includes('phone') ||
        text.includes('address') || text.includes('birth') || text.includes('gender') ||
        text.includes('city') || text.includes('nationality') ||
        // Only match bare "name" if it's not qualified by academic/institutional context
        (text.includes('name') && !text.includes('program') && !text.includes('course') &&
         !text.includes('university') && !text.includes('school') && !text.includes('institution') &&
         !text.includes('college') && !text.includes('document'))) {
      return 'PERSONAL_INFO';
    }

    return 'MISC';
  }

  /**
   * Extract required document list from text and file inputs
   */
  private extractRequiredDocuments($: cheerio.CheerioAPI, bodyText: string, fields: IExtractedField[]): string[] {
    const docs = new Set<string>();

    // From file inputs
    fields.filter((f) => f.type === 'file').forEach((f) => {
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
      if (new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(bodyText)) {
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
    const passportDetails = (profile?.passportDetails as Record<string, any>) || {};
    const academicHistory = (profile?.academicHistory as Record<string, any>) || {};
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
      passportNumber: passportDetails.passportNumber || passportDetails.number || unified.passportNumber,
      nationality: passportDetails.nationality || passportDetails.country || unified.nationality,
      dateOfBirth: passportDetails.dateOfBirth || passportDetails.dob || unified.dateOfBirth,
      gpa: academicHistory.gpa || academicHistory.cumulativeGpa || unified.gpa,
      degree: academicHistory.degree || academicHistory.degreeName || unified.degree,
      institution: academicHistory.institution || academicHistory.university || unified.institution,
      major: academicHistory.major || academicHistory.fieldOfStudy || unified.major,
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
   * Match an extracted application field against student data
   */
  private matchFieldToStudentData(field: IExtractedField, data: Record<string, any>): IAutofillFieldMatch {
    const text = `${field.name} ${field.label}`.toLowerCase();

    // 1. Personal Details Matching
    if (text.includes('first name') || text.includes('given name')) {
      return this.createMatch(field, data.firstName, 'USER_PROFILE', 0.95);
    }
    if (text.includes('last name') || text.includes('family name') || text.includes('surname')) {
      return this.createMatch(field, data.lastName, 'USER_PROFILE', 0.95);
    }
    if (text.includes('email')) {
      return this.createMatch(field, data.email, 'USER_PROFILE', 1.0);
    }
    if (text.includes('full name') || text.includes('applicant name') ||
        (text.includes('name') && !text.includes('school') && !text.includes('first') &&
         !text.includes('last') && !text.includes('university') && !text.includes('institution') &&
         !text.includes('program') && !text.includes('course') && !text.includes('college'))) {
      return this.createMatch(field, data.name, 'USER_PROFILE', 0.9);
    }

    // 2. Passport Matching
    if (text.includes('passport number') || text.includes('passport no') || text.includes('document id')) {
      return this.createMatch(field, data.passportNumber, 'PASSPORT', 0.95);
    }
    if (text.includes('nationality') || text.includes('citizenship') || text.includes('country of origin')) {
      return this.createMatch(field, data.nationality, 'PASSPORT', 0.9);
    }
    if (text.includes('date of birth') || text.includes('dob') || text.includes('birth date')) {
      return this.createMatch(field, data.dateOfBirth, 'PASSPORT', 0.9);
    }

    // 3. Academic History Matching
    if (text.includes('gpa') || text.includes('grade point average') || text.includes('cumulative grade')) {
      return this.createMatch(field, data.gpa, 'ACADEMIC', 0.95);
    }
    if (text.includes('degree') || text.includes('qualification')) {
      return this.createMatch(field, data.degree, 'ACADEMIC', 0.9);
    }
    if (text.includes('university') || text.includes('institution') || text.includes('college name') || text.includes('school name')) {
      return this.createMatch(field, data.institution, 'ACADEMIC', 0.9);
    }
    if (text.includes('major') || text.includes('field of study') || text.includes('specialization')) {
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
        const passportDoc = data.documents.find((d: any) => d.type === 'PASSPORT');
        return this.createMatch(field, passportDoc ? passportDoc.fileUrl : null, 'DOCUMENTS', 0.9);
      }
      if (text.includes('transcript')) {
        const transcriptDoc = data.documents.find((d: any) => d.type === 'TRANSCRIPT');
        return this.createMatch(field, transcriptDoc ? transcriptDoc.fileUrl : null, 'DOCUMENTS', 0.9);
      }
      if (text.includes('test') || text.includes('score') || text.includes('toefl') || text.includes('ielts')) {
        const testDoc = data.documents.find((d: any) => d.type === 'TEST_SCORE');
        return this.createMatch(field, testDoc ? testDoc.fileUrl : null, 'DOCUMENTS', 0.9);
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

  private createMatch(field: IExtractedField, value: any, source: IAutofillFieldMatch['source'], confidence: number): IAutofillFieldMatch {
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
      throw new BadRequestException(`Forbidden protocol '${parsedUrl.protocol}'. Only http and https URLs are allowed.`);
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
      hostname === '169.254.170.2' ||   // AWS ECS Task Metadata
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.amazonaws.com') // Block direct AWS metadata via custom DNS
    ) {
      throw new BadRequestException('Access to localhost or private network hostnames is blocked for security (SSRF Protection).');
    }

    // Check IP addresses if literal IP is passed
    if (net.isIP(hostname)) {
      if (this.isPrivateIp(hostname)) {
        throw new BadRequestException('Access to private IP address ranges is blocked for security (SSRF Protection).');
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
          this.logger.warn(`DNS rebinding attempt detected: ${hostname} resolved to private IP ${ip}`);
          throw new BadRequestException(
            `DNS for '${hostname}' resolves to a private IP address. Request blocked for security (SSRF Protection).`,
          );
        }
      }
    } catch (error: any) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.warn(`DNS resolution failed for ${hostname}: ${error.message}`);
      throw new BadRequestException(`Could not resolve hostname '${hostname}'. Ensure the URL is reachable.`);
    }
  }

  private isPrivateIp(ip: string): boolean {
    // IPv4 private/reserved ranges
    if (ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('169.254.')) {
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
}
