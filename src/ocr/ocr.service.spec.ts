import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { OcrService } from './ocr.service';

describe('OcrService', () => {
  let service: OcrService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OcrService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue(null),
          },
        },
      ],
    }).compile();

    service = module.get<OcrService>(OcrService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should extract text using fallback mode when AWS credentials are not set', async () => {
    const sampleBuffer = Buffer.from('Passport Number: A98765432\nFull Name: John Smith');
    const result = await service.processDocument(sampleBuffer, 'application/pdf');

    expect(result).toBeDefined();
    expect(result.engine).toBe('FALLBACK_LOCAL');
    expect(result.rawText).toContain('John Smith');
    expect(result.rawText).toContain('A98765432');
  });
});
