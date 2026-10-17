import { Test, TestingModule } from '@nestjs/testing';
import { Job } from 'bullmq';
import { InstitutionUpdatesProcessor } from './institution-updates.processor.js';
import {
  ScraperService,
  AntiBotChallengeError,
  ScrapeTimeoutError,
} from './scraper.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { IInstitutionUpdateJobData } from './scraper.dto.js';

describe('InstitutionUpdatesProcessor', () => {
  let processor: InstitutionUpdatesProcessor;
  let scraperService: any;
  let prismaService: any;

  const mockScraperService = {
    scrapeWithPlaywright: jest.fn(),
  };

  const mockPrismaService = {
    institution: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InstitutionUpdatesProcessor,
        {
          provide: ScraperService,
          useValue: mockScraperService,
        },
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    processor = module.get<InstitutionUpdatesProcessor>(
      InstitutionUpdatesProcessor,
    );
    scraperService = module.get<ScraperService>(ScraperService);
    prismaService = module.get<PrismaService>(PrismaService);
  });

  it('should be defined', () => {
    expect(processor).toBeDefined();
  });

  describe('process()', () => {
    it('should successfully extract university details and return scraped payload', async () => {
      const mockResult = {
        universityUrl: 'https://www.ox.ac.uk/admissions',
        pageTitle: 'University of Oxford Admissions',
        applicationDeadline: 'Application Deadline: January 15, 2027',
        estimatedTuition: 'Estimated Tuition: £28,500 per annum',
        recentNews: [
          {
            title: 'Oxford Announces 2027 Global Scholarship Cohort',
            link: 'https://www.ox.ac.uk/news/2027-scholarships',
            date: 'October 10, 2026',
            snippet: 'New scholarship opportunities opened for international students.',
          },
        ],
        scrapedAt: '2026-10-17T03:00:00.000Z',
      };

      mockScraperService.scrapeWithPlaywright.mockResolvedValue(mockResult);

      const mockJob = {
        id: 'job-101',
        data: {
          universityUrl: 'https://www.ox.ac.uk/admissions',
        } as IInstitutionUpdateJobData,
      } as Job<IInstitutionUpdateJobData>;

      const result = await processor.process(mockJob);

      expect(mockScraperService.scrapeWithPlaywright).toHaveBeenCalledWith(
        'https://www.ox.ac.uk/admissions',
      );
      expect(result).toEqual(mockResult);
    });

    it('should catch anti-bot / Cloudflare challenge errors and move job to failed state rather than crashing', async () => {
      mockScraperService.scrapeWithPlaywright.mockRejectedValue(
        new AntiBotChallengeError(
          'Anti-bot challenge page detected (HTTP 403 with title "Just a moment...")',
        ),
      );

      const mockJob = {
        id: 'job-102',
        data: {
          universityUrl: 'https://protected.university.edu/admissions',
        } as IInstitutionUpdateJobData,
      } as Job<IInstitutionUpdateJobData>;

      await expect(processor.process(mockJob)).rejects.toThrow(
        /Institution scraping failed: Anti-bot challenge page detected/,
      );
    });

    it('should catch navigation timeouts and move job to failed state without crashing', async () => {
      mockScraperService.scrapeWithPlaywright.mockRejectedValue(
        new ScrapeTimeoutError(
          'Navigation timed out after 30s while reaching: https://slow.university.edu',
        ),
      );

      const mockJob = {
        id: 'job-103',
        data: {
          universityUrl: 'https://slow.university.edu',
        } as IInstitutionUpdateJobData,
      } as Job<IInstitutionUpdateJobData>;

      await expect(processor.process(mockJob)).rejects.toThrow(
        /Institution scraping failed: Navigation timed out after 30s/,
      );
    });

    it('should update Institution in database if institutionId is provided', async () => {
      const mockResult = {
        universityUrl: 'https://www.cam.ac.uk/admissions',
        pageTitle: 'University of Cambridge Admissions',
        applicationDeadline: 'October 15, 2026',
        estimatedTuition: '£33,825 / year',
        recentNews: [],
        scrapedAt: '2026-10-17T03:00:00.000Z',
      };

      mockScraperService.scrapeWithPlaywright.mockResolvedValue(mockResult);
      mockPrismaService.institution.findUnique.mockResolvedValue({
        id: 'inst-1',
        name: 'University of Cambridge',
        metadata: { existingKey: 'value' },
      });
      mockPrismaService.institution.update.mockResolvedValue({ id: 'inst-1' });

      const mockJob = {
        id: 'job-104',
        data: {
          universityUrl: 'https://www.cam.ac.uk/admissions',
          institutionId: 'inst-1',
        } as IInstitutionUpdateJobData,
      } as Job<IInstitutionUpdateJobData>;

      await processor.process(mockJob);

      expect(mockPrismaService.institution.findUnique).toHaveBeenCalledWith({
        where: { id: 'inst-1' },
      });
      expect(mockPrismaService.institution.update).toHaveBeenCalledWith({
        where: { id: 'inst-1' },
        data: {
          metadata: {
            existingKey: 'value',
            scrapedDeadline: 'October 15, 2026',
            scrapedTuition: '£33,825 / year',
            recentNews: [],
            lastScrapedAt: '2026-10-17T03:00:00.000Z',
            pageTitle: 'University of Cambridge Admissions',
          },
        },
      });
    });
  });
});
