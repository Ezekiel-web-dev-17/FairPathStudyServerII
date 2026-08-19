import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ScraperService } from './scraper.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

describe('ScraperService', () => {
  let service: ScraperService;
  let prismaService: any;

  const mockPrismaService = {
    user: {
      findUnique: jest.fn(),
    },
    studentProfile: {
      update: jest.fn(),
      create: jest.fn(),
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScraperService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    service = module.get<ScraperService>(ScraperService);
    prismaService = module.get<PrismaService>(PrismaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('parseFormFieldsFromHtml', () => {
    it('should correctly parse HTML form fields, labels, categories, and required flags', () => {
      const sampleHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>University of Tech Application Portal</title>
          <meta name="publisher" content="University of Tech" />
        </head>
        <body>
          <h1>M.Sc. Computer Science Application</h1>
          <p>Application Deadline: December 15, 2026</p>
          <p>Application Fee: $75 USD</p>
          <form>
            <div class="form-group">
              <label for="first_name">First Name *</label>
              <input type="text" id="first_name" name="first_name" required />
            </div>
            <div class="form-group">
              <label for="last_name">Last Name *</label>
              <input type="text" id="last_name" name="last_name" required />
            </div>
            <div class="form-group">
              <label for="email">Email Address *</label>
              <input type="email" id="email" name="email" required />
            </div>
            <div class="form-group">
              <label for="gpa">Cumulative GPA</label>
              <input type="number" id="gpa" name="gpa" placeholder="e.g. 3.8" />
            </div>
            <div class="form-group">
              <label for="toefl">TOEFL iBT Score</label>
              <input type="number" id="toefl" name="toefl_score" />
            </div>
            <div class="form-group">
              <label for="transcript">Official Transcript</label>
              <input type="file" id="transcript" name="transcript_file" required />
            </div>
          </form>
          <p>Required: Passport Copy, Official Transcript, Statement of Purpose</p>
        </body>
        </html>
      `;

      const result = service.parseFormFieldsFromHtml(sampleHtml, 'https://univ.edu/apply');

      expect(result.title).toBe('M.Sc. Computer Science Application');
      expect(result.institutionName).toBe('University of Tech');
      expect(result.deadline).toBe('December 15, 2026');
      expect(result.applicationFee).toBe('$75 USD');
      expect(result.portalUrl).toBe('https://univ.edu/apply');
      expect(result.extractedFields.length).toBe(6);

      const emailField = result.extractedFields.find((f) => f.id === 'email');
      expect(emailField).toBeDefined();
      expect(emailField?.type).toBe('email');
      expect(emailField?.required).toBe(true);
      expect(emailField?.inferredCategory).toBe('PERSONAL_INFO');

      const transcriptField = result.extractedFields.find((f) => f.id === 'transcript');
      expect(transcriptField).toBeDefined();
      expect(transcriptField?.type).toBe('file');
      expect(transcriptField?.inferredCategory).toBe('DOCUMENT_UPLOAD');

      expect(result.requiredDocuments).toContain('Official Transcript');
      expect(result.requiredDocuments).toContain('Passport Copy');
      expect(result.requiredDocuments).toContain('Statement of Purpose');
    });
  });

  describe('SSRF Protection (validateUrlForSsrf)', () => {
    it('should throw BadRequestException when trying to scrape localhost or private IP', async () => {
      await expect(service.scrapeApplicationPage('http://localhost:3000/apply')).rejects.toThrow(BadRequestException);
      await expect(service.scrapeApplicationPage('http://127.0.0.1/admin')).rejects.toThrow(BadRequestException);
      await expect(service.scrapeApplicationPage('http://169.254.169.254/latest/meta-data')).rejects.toThrow(BadRequestException);
      await expect(service.scrapeApplicationPage('http://192.168.1.1/dashboard')).rejects.toThrow(BadRequestException);
      await expect(service.scrapeApplicationPage('ftp://example.com/apply')).rejects.toThrow(BadRequestException);
    });
  });

  describe('autofillStudentApplication', () => {
    it('should throw NotFoundException if student is not found', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(null);

      await expect(
        service.autofillStudentApplication('student-999', undefined, '<html><body><form><input name="test"/></form></body></html>'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should map student profile & document data to form fields and calculate completion percentage', async () => {
      const mockUser = {
        id: 'student-101',
        email: 'jane.doe@example.com',
        name: 'Jane Doe',
        profile: {
          id: 'prof-1',
          studentId: 'student-101',
          passportDetails: {
            passportNumber: 'N12345678',
            nationality: 'Canadian',
            dateOfBirth: '1998-05-15',
          },
          academicHistory: {
            gpa: 3.92,
            degree: 'Bachelor of Science',
            institution: 'University of Toronto',
            major: 'Computer Science',
          },
          testScores: {
            toefl: 110,
          },
          unifiedProfile: {},
        },
        documents: [
          {
            id: 'doc-1',
            type: 'TRANSCRIPT',
            fileName: 'transcript.pdf',
            fileUrl: 'https://s3.amazonaws.com/bucket/transcript.pdf',
          },
          {
            id: 'doc-2',
            type: 'PASSPORT',
            fileName: 'passport.png',
            fileUrl: 'https://s3.amazonaws.com/bucket/passport.png',
          },
        ],
      };

      mockPrismaService.user.findUnique.mockResolvedValue(mockUser);

      const html = `
        <html>
          <body>
            <h1>Graduate Application</h1>
            <form>
              <label for="fname">First Name *</label>
              <input type="text" id="fname" name="first_name" required />

              <label for="email">Email *</label>
              <input type="email" id="email" name="email" required />

              <label for="gpa">Cumulative GPA *</label>
              <input type="number" id="gpa" name="gpa" required />

              <label for="toefl">TOEFL Score</label>
              <input type="number" id="toefl" name="toefl_score" />

              <label for="passport">Passport Copy *</label>
              <input type="file" id="passport" name="passport_file" required />

              <label for="sop">Statement of Purpose *</label>
              <textarea id="sop" name="sop" required></textarea>
            </form>
          </body>
        </html>
      `;

      const result = await service.autofillStudentApplication('student-101', undefined, html);

      expect(result.studentId).toBe('student-101');
      expect(result.totalFieldsCount).toBe(6);
      expect(result.filledFieldsCount).toBe(5); // fname, email, gpa, toefl, passport
      expect(result.completionPercentage).toBe(83); // 5 / 6 = 83%

      const emailMatch = result.fieldMatches.find((m) => m.field.id === 'email');
      expect(emailMatch?.isFilled).toBe(true);
      expect(emailMatch?.autofilledValue).toBe('jane.doe@example.com');
      expect(emailMatch?.source).toBe('USER_PROFILE');

      const gpaMatch = result.fieldMatches.find((m) => m.field.id === 'gpa');
      expect(gpaMatch?.isFilled).toBe(true);
      expect(gpaMatch?.autofilledValue).toBe(3.92);
      expect(gpaMatch?.source).toBe('ACADEMIC');

      const passportFileMatch = result.fieldMatches.find((m) => m.field.id === 'passport');
      expect(passportFileMatch?.isFilled).toBe(true);
      expect(passportFileMatch?.autofilledValue).toBe('https://s3.amazonaws.com/bucket/passport.png');

      // SOP is missing
      expect(result.missingRequiredFields.length).toBe(1);
      expect(result.missingRequiredFields[0].id).toBe('sop');
    });
  });

  describe('saveAutofilledApplication', () => {
    it('should save autofilled data to StudentProfile unifiedProfile in Prisma', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'student-101',
        profile: {
          id: 'prof-1',
          studentId: 'student-101',
          unifiedProfile: { previousData: 'ok' },
        },
      });

      mockPrismaService.studentProfile.update.mockResolvedValue({
        id: 'prof-1',
        studentId: 'student-101',
        unifiedProfile: { updated: true },
      });

      const appData = { field1: 'val1', field2: 'val2' };
      await service.saveAutofilledApplication('student-101', appData);

      expect(mockPrismaService.studentProfile.update).toHaveBeenCalledWith({
        where: { studentId: 'student-101' },
        data: {
          unifiedProfile: expect.objectContaining({
            previousData: 'ok',
            lastAutofilledApplication: expect.objectContaining({
              applicationData: appData,
            }),
          }),
        },
      });
    });
  });
});
