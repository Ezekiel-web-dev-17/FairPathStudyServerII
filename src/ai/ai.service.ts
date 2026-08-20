import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import { AiConfig, parseAiConfig } from './ai.config.js';

/**
 * Represents a single AI-generated field match: which student data value
 * should fill which form field, and how confident the model is.
 */
export interface IAiFieldMatch {
  /** The form field ID from the scraped application */
  fieldId: string;
  /** The key in the student data store that matches this field */
  studentDataKey: string | null;
  /** The suggested value to autofill */
  suggestedValue: string | null;
  /** Data source category */
  source: 'USER_PROFILE' | 'PASSPORT' | 'ACADEMIC' | 'TEST_SCORES' | 'DOCUMENTS' | 'NONE';
  /** Model's confidence in this match (0.0 – 1.0) */
  confidence: number;
}

/**
 * Represents a structured data extraction result from raw OCR text.
 */
export interface IAiExtractedData {
  [key: string]: string | number | null;
}

@Injectable()
export class AiService implements OnModuleInit {
  private readonly logger = new Logger(AiService.name);
  private model: GenerativeModel | null = null;
  private config: AiConfig | null = null;

  /** Maximum retries for rate-limited (429) requests */
  private readonly MAX_RETRIES = 3;
  /** Base delay in ms for exponential backoff */
  private readonly BASE_DELAY_MS = 1000;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    this.config = parseAiConfig();

    if (this.config?.AI_ENABLED && this.config.GEMINI_API_KEY) {
      const genAI = new GoogleGenerativeAI(this.config.GEMINI_API_KEY);
      this.model = genAI.getGenerativeModel({
        model: this.config.AI_MODEL,
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.1, // Low temperature for deterministic structured output
        },
      });
      this.logger.log(`Gemini model "${this.config.AI_MODEL}" initialized.`);
    } else {
      this.logger.log('AI service running in disabled mode — all calls will return null.');
    }
  }

  /**
   * Whether the AI service is active and ready to process requests.
   */
  get isEnabled(): boolean {
    return this.model !== null && (this.config?.AI_ENABLED ?? false);
  }

  /**
   * Semantically match form fields to student data using Gemini.
   *
   * Given a list of extracted form fields and a student data dictionary,
   * the model identifies which student data key best fills each field,
   * along with a confidence score and data source category.
   *
   * @returns Array of field matches, or null if AI is disabled / fails.
   */
  async matchFieldsToStudentData(
    fields: Array<{ id: string; name: string; label: string; type: string }>,
    studentData: Record<string, unknown>,
  ): Promise<IAiFieldMatch[] | null> {
    if (!this.isEnabled) return null;

    // Strip documents array from prompt to keep it concise; file matching is done separately
    const { documents, ...dataWithoutDocs } = studentData as Record<string, unknown>;

    const prompt = `You are a university application form autofill assistant.

Given the following form fields extracted from a university application page, and the student's profile data, match each form field to the most appropriate student data key.

## Form Fields
${JSON.stringify(fields, null, 2)}

## Student Data (available keys and values)
${JSON.stringify(dataWithoutDocs, null, 2)}

## Instructions
For EACH form field, return a JSON object with:
- "fieldId": the field's id
- "studentDataKey": the key from student data that best matches this field, or null if no match
- "suggestedValue": the actual value from student data to autofill, or null
- "source": one of "USER_PROFILE", "PASSPORT", "ACADEMIC", "TEST_SCORES", "DOCUMENTS", or "NONE"
- "confidence": a number between 0.0 and 1.0 representing how confident you are in the match

Use semantic understanding — for example:
- "Forename" or "Nombre" should match "firstName"
- "Qualification" should match "degree"
- "Country of Origin" should match "nationality"

Return a JSON array of match objects. Only return valid JSON, no markdown or explanation.`;

    try {
      const responseText = await this.generateWithRetry(prompt);
      if (!responseText) return null;

      const parsed = JSON.parse(responseText);
      if (!Array.isArray(parsed)) {
        this.logger.warn('AI field matching returned non-array response.');
        return null;
      }

      return parsed as IAiFieldMatch[];
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`AI field matching failed: ${message}`);
      return null;
    }
  }

  /**
   * Extract structured data from raw OCR text using Gemini.
   *
   * Processes messy OCR output (from passports, transcripts, score reports)
   * and returns a clean JSON object with the extracted fields.
   *
   * @param ocrText   Raw text from OCR (e.g., AWS Textract output)
   * @param documentType  Type hint: 'PASSPORT', 'TRANSCRIPT', 'TEST_SCORE', or 'OTHER'
   * @returns Structured key-value data, or null if AI is disabled / fails.
   */
  async extractStructuredData(
    ocrText: string,
    documentType: 'PASSPORT' | 'TRANSCRIPT' | 'TEST_SCORE' | 'OTHER',
  ): Promise<IAiExtractedData | null> {
    if (!this.isEnabled) return null;

    // Truncate excessively long OCR text to prevent token limit issues
    const truncatedText = ocrText.length > 15000 ? ocrText.slice(0, 15000) : ocrText;

    const fieldHints: Record<string, string> = {
      PASSPORT: 'full name, first name, last name, passport number, nationality, date of birth, gender, date of issue, date of expiry, place of birth, issuing authority',
      TRANSCRIPT: 'full name, student ID, institution name, degree, major/field of study, GPA/cumulative GPA, graduation date, courses and grades',
      TEST_SCORE: 'full name, test type (TOEFL/IELTS/GRE/GMAT/SAT), overall score, section scores (reading, writing, listening, speaking, verbal, quantitative, analytical writing), test date, registration number',
      OTHER: 'any identifiable personal information, dates, names, numbers, or structured data',
    };

    const prompt = `You are a document data extraction specialist.

Extract structured data from the following raw OCR text of a ${documentType} document.

## Raw OCR Text
${truncatedText}

## Expected Fields
Look for these fields: ${fieldHints[documentType]}

## Instructions
- Return a flat JSON object with camelCase keys and string/number values.
- If a field is not found in the text, set its value to null.
- For dates, use ISO 8601 format (YYYY-MM-DD) when possible.
- For scores, use numeric values.
- Only return valid JSON, no markdown or explanation.`;

    try {
      const responseText = await this.generateWithRetry(prompt);
      if (!responseText) return null;

      const parsed = JSON.parse(responseText);
      if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.logger.warn('AI data extraction returned non-object response.');
        return null;
      }

      return parsed as IAiExtractedData;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`AI data extraction failed: ${message}`);
      return null;
    }
  }

  /**
   * Generate content with exponential backoff retry on rate limit (429) errors.
   */
  private async generateWithRetry(prompt: string): Promise<string | null> {
    if (!this.model) return null;

    for (let attempt = 0; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        const result = await this.model.generateContent(prompt);
        const text = result.response.text();

        if (!text || text.trim().length === 0) {
          this.logger.warn('Gemini returned empty response.');
          return null;
        }

        return text.trim();
      } catch (error: unknown) {
        const statusCode = (error as { status?: number })?.status;
        const message = error instanceof Error ? error.message : String(error);

        if (statusCode === 429 && attempt < this.MAX_RETRIES) {
          const delay = this.BASE_DELAY_MS * Math.pow(2, attempt);
          this.logger.warn(
            `Rate limited (429). Retrying in ${delay}ms (attempt ${attempt + 1}/${this.MAX_RETRIES})...`,
          );
          await this.sleep(delay);
          continue;
        }

        this.logger.error(`Gemini API error (attempt ${attempt + 1}): ${message}`);
        throw error;
      }
    }

    return null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
