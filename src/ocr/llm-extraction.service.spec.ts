import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { LlmExtractionService } from './llm-extraction.service';

describe('LlmExtractionService', () => {
  let service: LlmExtractionService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LlmExtractionService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue(null),
          },
        },
      ],
    }).compile();

    service = module.get<LlmExtractionService>(LlmExtractionService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should extract structured JSON fields for PASSPORT document type via fallback parser', async () => {
    const rawOcrText = 'PASSPORT\nNumber: B9876543\nName: Jane Doe\nNationality: USA';
    const result = await service.extractStructuredData('PASSPORT', rawOcrText);

    expect(result).toBeDefined();
    expect(result.documentType).toBe('PASSPORT');
    expect(result.extractedFields).toHaveProperty('passportNumber');
    expect(result.extractedFields).toHaveProperty('fullName');
  });

  it('should extract structured JSON fields for TRANSCRIPT document type', async () => {
    const rawOcrText = 'Official Transcript\nStudent GPA: 3.90\nDegree: BS Computer Science';
    const result = await service.extractStructuredData('TRANSCRIPT', rawOcrText);

    expect(result).toBeDefined();
    expect(result.extractedFields).toHaveProperty('gpa');
    expect(result.extractedFields).toHaveProperty('courses');
    expect(Array.isArray(result.extractedFields.courses)).toBe(true);
  });
});
