import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ScraperController } from './scraper.controller.js';
import { ScraperService } from './scraper.service.js';

describe('ScraperController', () => {
  let controller: ScraperController;
  let service: ScraperService;

  const mockScraperService = {
    scrapeApplicationPage: jest.fn(),
    parseFormFieldsFromHtml: jest.fn(),
    autofillStudentApplication: jest.fn(),
    saveAutofilledApplication: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ScraperController],
      providers: [
        {
          provide: ScraperService,
          useValue: mockScraperService,
        },
      ],
    }).compile();

    controller = module.get<ScraperController>(ScraperController);
    service = module.get<ScraperService>(ScraperService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('POST /scraper/scrape', () => {
    it('should throw BadRequestException if URL is invalid', async () => {
      await expect(controller.scrapeUrl({ url: 'not-a-valid-url' } as any)).rejects.toThrow(BadRequestException);
    });

    it('should call scraperService.scrapeApplicationPage with valid URL', async () => {
      const mockResult = { title: 'Test Portal', extractedFields: [] } as any;
      mockScraperService.scrapeApplicationPage.mockResolvedValue(mockResult);

      const res = await controller.scrapeUrl({ url: 'https://univ.edu/apply' });
      expect(res).toEqual(mockResult);
      expect(service.scrapeApplicationPage).toHaveBeenCalledWith('https://univ.edu/apply');
    });
  });

  describe('POST /scraper/parse-html', () => {
    it('should throw BadRequestException if html is empty', async () => {
      await expect(controller.parseHtml({ html: '' } as any)).rejects.toThrow(BadRequestException);
    });

    it('should call scraperService.parseFormFieldsFromHtml', async () => {
      const mockResult = { title: 'Test Form', extractedFields: [] } as any;
      mockScraperService.parseFormFieldsFromHtml.mockReturnValue(mockResult);

      const html = '<html><body><form><input name="test"/></form></body></html>';
      const res = await controller.parseHtml({ html, url: 'https://univ.edu/form' });
      expect(res).toEqual(mockResult);
      expect(service.parseFormFieldsFromHtml).toHaveBeenCalledWith(html, 'https://univ.edu/form');
    });
  });

  describe('POST /scraper/autofill', () => {
    it('should throw BadRequestException if neither targetUrl nor rawHtml is provided', async () => {
      await expect(controller.autofillApplication({ studentId: 'student-101' } as any)).rejects.toThrow(BadRequestException);
    });

    it('should call scraperService.autofillStudentApplication', async () => {
      const mockResult = { studentId: 'student-101', completionPercentage: 100 } as any;
      mockScraperService.autofillStudentApplication.mockResolvedValue(mockResult);

      const dto = { studentId: 'student-101', targetUrl: 'https://univ.edu/apply' };
      const res = await controller.autofillApplication(dto);
      expect(res).toEqual(mockResult);
      expect(service.autofillStudentApplication).toHaveBeenCalledWith('student-101', 'https://univ.edu/apply', undefined);
    });
  });

  describe('POST /scraper/student/:studentId/save', () => {
    it('should call scraperService.saveAutofilledApplication', async () => {
      const mockResult = { id: 'prof-1', studentId: 'student-101' } as any;
      mockScraperService.saveAutofilledApplication.mockResolvedValue(mockResult);

      const dto = { studentId: 'student-101', applicationData: { field: 'val' } };
      const res = await controller.saveAutofill('student-101', dto);
      expect(res).toEqual(mockResult);
      expect(service.saveAutofilledApplication).toHaveBeenCalledWith('student-101', { field: 'val' });
    });
  });
});
