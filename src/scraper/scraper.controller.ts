import { Controller, Post, Get, Body, Param, ParseIntPipe, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ScraperService } from './scraper.service.js';
import {
  ScrapeUrlSchema,
  ParseHtmlSchema,
  AutofillApplicationSchema,
  SaveApplicationSchema,
  ScrapeUrlDto,
  ParseHtmlDto,
  AutofillApplicationDto,
  SaveApplicationDto,
} from './scraper.dto.js';

@ApiTags('Scraper & Autofill')
@Controller('scraper')
export class ScraperController {
  constructor(private readonly scraperService: ScraperService) {}

  @Post('scrape')
  @ApiOperation({ summary: 'Scrape an application portal URL to extract required fields' })
  @ApiResponse({ status: 200, description: 'Application page scraped successfully.' })
  @ApiResponse({ status: 400, description: 'Invalid URL or SSRF protection triggered.' })
  async scrapeUrl(@Body() body: ScrapeUrlDto) {
    const parseResult = ScrapeUrlSchema.safeParse(body);
    if (!parseResult.success) {
      const messages = parseResult.error.issues
        ? parseResult.error.issues.map((e) => e.message).join(', ')
        : parseResult.error.message;
      throw new BadRequestException(messages);
    }
    return this.scraperService.scrapeApplicationPage(parseResult.data.url);
  }

  @Post('parse-html')
  @ApiOperation({ summary: 'Parse raw HTML form code to extract application fields' })
  @ApiResponse({ status: 200, description: 'HTML parsed successfully.' })
  async parseHtml(@Body() body: ParseHtmlDto) {
    const parseResult = ParseHtmlSchema.safeParse(body);
    if (!parseResult.success) {
      const messages = parseResult.error.issues
        ? parseResult.error.issues.map((e) => e.message).join(', ')
        : parseResult.error.message;
      throw new BadRequestException(messages);
    }
    return this.scraperService.parseFormFieldsFromHtml(parseResult.data.html, parseResult.data.url);
  }

  @Post('autofill')
  @ApiOperation({ summary: 'Autofill application fields for a student using profile and OCR data' })
  @ApiResponse({ status: 200, description: 'Application fields autofilled successfully.' })
  async autofillApplication(@Body() body: AutofillApplicationDto) {
    const parseResult = AutofillApplicationSchema.safeParse(body);
    if (!parseResult.success) {
      const messages = parseResult.error.issues
        ? parseResult.error.issues.map((e) => e.message).join(', ')
        : parseResult.error.message;
      throw new BadRequestException(messages);
    }
    const { studentId, targetUrl, rawHtml } = parseResult.data;
    return this.scraperService.autofillStudentApplication(studentId, targetUrl, rawHtml);
  }

  @Post('student/:studentId/save')
  @ApiOperation({ summary: 'Save autofilled application data to student profile' })
  @ApiResponse({ status: 200, description: 'Autofilled application saved successfully.' })
  async saveAutofill(
    @Param('studentId') studentId: string,
    @Body() body: SaveApplicationDto,
  ) {
    const parseResult = SaveApplicationSchema.safeParse({ ...body, studentId });
    if (!parseResult.success) {
      const messages = parseResult.error.issues
        ? parseResult.error.issues.map((e) => e.message).join(', ')
        : parseResult.error.message;
      throw new BadRequestException(messages);
    }
    return this.scraperService.saveAutofilledApplication(studentId, body.applicationData);
  }
}
