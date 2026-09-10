import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  createUserSchema,
  updateUserSchema,
  changePasswordSchema,
  CreateUserDto,
  UpdateUserDto,
  ChangePasswordDto,
} from './users.dto.js';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly prisma: PrismaService) {}

  private sanitizeUser<T extends Record<string, any>>(user: T): Omit<T, 'password'> {
    if (!user) return user;
    const { password: _, ...sanitized } = user;
    return sanitized;
  }

  async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 10);
  }

  async verifyPassword(password: string, storedHash: string): Promise<boolean> {
    if (!storedHash) {
      return false;
    }
    return bcrypt.compare(password, storedHash);
  }

  async register(data: CreateUserDto) {
    const parseResult = createUserSchema.safeParse(data);
    if (!parseResult.success) {
      const errorMsg = parseResult.error.issues.map((e) => e.message).join(', ');
      throw new BadRequestException(`Validation failed: ${errorMsg}`);
    }

    const { name, email, password } = parseResult.data;

    const existingUser = await this.prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      throw new BadRequestException('User with this email already exists!');
    }

    const hashedPassword = await this.hashPassword(password);

    const user = await this.prisma.user.create({
      data: {
        email,
        name,
        password: hashedPassword,
      },
    });

    this.logger.log(`Created new user [ID: ${user.id}, Email: ${user.email}]`);

    return this.sanitizeUser(user);
  }

  async findAll() {
    const users = await this.prisma.user.findMany({
      include: {
        profile: true,
        _count: {
          select: { documents: true, notifications: true },
        },
      },
      orderBy: { id: 'asc' },
    });

    return users.map((u) => this.sanitizeUser(u));
  }

  private async findUserWithPassword(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        profile: true,
        documents: {
          orderBy: { createdAt: 'desc' },
        },
        notifications: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!user) {
      throw new NotFoundException(`User with ID '${id}' not found.`);
    }

    return user;
  }

  async findOne(id: string) {
    const user = await this.findUserWithPassword(id);
    return this.sanitizeUser(user);
  }

  async update(id: string, data: UpdateUserDto) {
    const parseResult = updateUserSchema.safeParse(data);
    if (!parseResult.success) {
      const errorMsg = parseResult.error.issues.map((e) => e.message).join(', ');
      throw new BadRequestException(`Validation failed: ${errorMsg}`);
    }

    await this.findUserWithPassword(id);

    if (parseResult.data.email) {
      const existingUser = await this.prisma.user.findUnique({
        where: { email: parseResult.data.email },
      });
      if (existingUser && existingUser.id !== id) {
        throw new BadRequestException('Email address is already in use by another user.');
      }
    }

    const updatedUser = await this.prisma.user.update({
      where: { id },
      data: parseResult.data,
    });

    return this.sanitizeUser(updatedUser);
  }

  async changePassword(id: string, data: ChangePasswordDto) {
    const parseResult = changePasswordSchema.safeParse(data);
    if (!parseResult.success) {
      const errorMsg = parseResult.error.issues.map((e) => e.message).join(', ');
      throw new BadRequestException(`Validation failed: ${errorMsg}`);
    }

    const { currentPassword, newPassword } = parseResult.data;

    const user = await this.findUserWithPassword(id);

    if (user.password && !(await this.verifyPassword(currentPassword, user.password))) {
      throw new BadRequestException('Current password provided is incorrect.');
    }

    const newHashedPassword = await this.hashPassword(newPassword);

    await this.prisma.user.update({
      where: { id },
      data: { password: newHashedPassword },
    });

    this.logger.log(`Password updated successfully for user ID [${id}]`);
    return { message: 'Password updated successfully.' };
  }

  async remove(id: string) {
    await this.findUserWithPassword(id);

    await this.prisma.user.delete({
      where: { id },
    });

    return { message: `User '${id}' successfully deleted.` };
  }

  async getStudentDocuments(studentId: string) {
    await this.findUserWithPassword(studentId);

    return this.prisma.document.findMany({
      where: { studentId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getStudentProfile(studentId: string) {
    const profile = await this.prisma.studentProfile.findUnique({
      where: { studentId },
      include: {
        student: {
          select: { id: true, email: true, name: true },
        },
      },
    });

    if (!profile) {
      throw new NotFoundException(`Profile for student ID '${studentId}' not found.`);
    }

    return profile;
  }
}
