import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

describe('UsersService', () => {
  let service: UsersService;
  let prisma: any;

  const mockPrisma = {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    document: {
      findMany: jest.fn(),
    },
    studentProfile: {
      findUnique: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('password hashing', () => {
    it('should hash password with bcryptjs and verify correctly', async () => {
      const plain = 'SecretP@ssword123';
      const hashed = await service.hashPassword(plain);

      expect(hashed).toMatch(/^\$2[ab]\$/);
      expect(await service.verifyPassword(plain, hashed)).toBe(true);
      expect(await service.verifyPassword('WrongPassword', hashed)).toBe(false);
    });
  });

  describe('register', () => {
    it('should register a user with hashed password successfully', async () => {
      const dto = {
        name: 'Jane Doe',
        email: 'jane@example.com',
        password: 'password123',
        confirmPassword: 'password123',
      };

      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.user.create.mockImplementation(({ data }) =>
        Promise.resolve({
          id: 'user-uuid-1',
          name: data.name,
          email: data.email,
          password: data.password,
        }),
      );

      const result = await service.register(dto);
      expect(result.id).toBe('user-uuid-1');
      expect(result).not.toHaveProperty('password');
      expect(mockPrisma.user.create).toHaveBeenCalledWith({
        data: {
          name: 'Jane Doe',
          email: 'jane@example.com',
          password: expect.stringMatching(/^\$2[ab]\$/),
        },
      });
    });

    it('should throw BadRequestException if passwords do not match', async () => {
      const dto = {
        name: 'Jane Doe',
        email: 'jane@example.com',
        password: 'password123',
        confirmPassword: 'mismatchpassword',
      };

      await expect(service.register(dto)).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if user email already exists', async () => {
      const dto = {
        name: 'Jane Doe',
        email: 'jane@example.com',
        password: 'password123',
        confirmPassword: 'password123',
      };

      mockPrisma.user.findUnique.mockResolvedValue({ id: 'existing-id', email: 'jane@example.com' });

      await expect(service.register(dto)).rejects.toThrow(BadRequestException);
    });
  });

  describe('changePassword', () => {
    it('should update user password successfully when current password is correct', async () => {
      const oldHash = await service.hashPassword('OldPassword123');
      const mockUser = { id: 'user-1', name: 'John', email: 'john@example.com', password: oldHash };

      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      mockPrisma.user.update.mockResolvedValue({ ...mockUser });

      const dto = {
        currentPassword: 'OldPassword123',
        newPassword: 'NewPassword123',
        confirmPassword: 'NewPassword123',
      };

      const res = await service.changePassword('user-1', dto);
      expect(res.message).toBe('Password updated successfully.');
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { password: expect.stringMatching(/^\$2[ab]\$/) },
      });
    });

    it('should throw BadRequestException when current password is incorrect', async () => {
      const oldHash = await service.hashPassword('OldPassword123');
      const mockUser = { id: 'user-1', name: 'John', email: 'john@example.com', password: oldHash };

      mockPrisma.user.findUnique.mockResolvedValue(mockUser);

      const dto = {
        currentPassword: 'WrongOldPassword',
        newPassword: 'NewPassword123',
        confirmPassword: 'NewPassword123',
      };

      await expect(service.changePassword('user-1', dto)).rejects.toThrow(BadRequestException);
    });
  });

  describe('findOne', () => {
    it('should return a user if found', async () => {
      const mockUser = { id: 'user-1', name: 'John Doe', email: 'john@example.com' };
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);

      const result = await service.findOne('user-1');
      expect(result).toBe(mockUser);
    });

    it('should throw NotFoundException if user not found', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(service.findOne('invalid-id')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getStudentDocuments', () => {
    it('should return list of documents for a student', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'student-1' });
      mockPrisma.document.findMany.mockResolvedValue([
        { id: 'doc-1', fileName: 'transcript.pdf', studentId: 'student-1' },
      ]);

      const docs = await service.getStudentDocuments('student-1');
      expect(docs).toHaveLength(1);
      expect(docs[0].fileName).toBe('transcript.pdf');
    });
  });

  describe('getStudentProfile', () => {
    it('should return unified profile if exists', async () => {
      const mockProfile = { id: 'prof-1', studentId: 'student-1', unifiedProfile: {} };
      mockPrisma.studentProfile.findUnique.mockResolvedValue(mockProfile);

      const profile = await service.getStudentProfile('student-1');
      expect(profile).toBe(mockProfile);
    });

    it('should throw NotFoundException if profile does not exist', async () => {
      mockPrisma.studentProfile.findUnique.mockResolvedValue(null);

      await expect(service.getStudentProfile('student-1')).rejects.toThrow(NotFoundException);
    });
  });
});
