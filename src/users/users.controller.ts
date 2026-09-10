import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Param,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiBody } from '@nestjs/swagger';
import { WithArcjetRules, fixedWindow } from '@arcjet/nest';
import { UsersService } from './users.service.js';
import type { CreateUserDto, UpdateUserDto, ChangePasswordDto } from './users.dto.js';
import { getArcjetMode } from '../config/arcjet.config.js';

@ApiTags('Users')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post('register')
  @WithArcjetRules([
    fixedWindow({
      mode: getArcjetMode(),
      window: '15m',
      max: 5,
    }),
  ])
  @ApiOperation({ summary: 'Register a new user' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['name', 'email', 'password', 'confirmPassword'],
      properties: {
        name: { type: 'string', example: 'Jane Doe' },
        email: { type: 'string', example: 'jane.doe@example.com' },
        password: { type: 'string', example: 'SecureP@ssword123' },
        confirmPassword: { type: 'string', example: 'SecureP@ssword123' },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'User successfully created.' })
  @ApiResponse({ status: 400, description: 'Validation error or email already in use.' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded.' })
  async register(@Body() data: CreateUserDto) {
    return this.usersService.register(data);
  }

  @Get()
  @ApiOperation({ summary: 'List all registered users' })
  @ApiResponse({ status: 200, description: 'Returns array of all users.' })
  async findAll() {
    return this.usersService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get user details by ID' })
  @ApiParam({ name: 'id', description: 'User UUID', example: '123e4567-e89b-12d3-a456-426614174000' })
  @ApiResponse({ status: 200, description: 'Returns user record.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  async findOne(@Param('id') id: string) {
    return this.usersService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update user profile info by ID' })
  @ApiParam({ name: 'id', description: 'User UUID' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', example: 'Jane Smith' },
        email: { type: 'string', example: 'jane.smith@example.com' },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'User updated successfully.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  async update(@Param('id') id: string, @Body() data: UpdateUserDto) {
    return this.usersService.update(id, data);
  }

  @Patch(':id/password')
  @WithArcjetRules([
    fixedWindow({
      mode: getArcjetMode(),
      window: '15m',
      max: 5,
    }),
  ])
  @ApiOperation({ summary: 'Change user password' })
  @ApiParam({ name: 'id', description: 'User UUID' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['currentPassword', 'newPassword', 'confirmPassword'],
      properties: {
        currentPassword: { type: 'string', example: 'OldPassword123' },
        newPassword: { type: 'string', example: 'NewSecurePassword123' },
        confirmPassword: { type: 'string', example: 'NewSecurePassword123' },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Password updated successfully.' })
  @ApiResponse({ status: 400, description: 'Invalid current password or validation error.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded.' })
  async changePassword(@Param('id') id: string, @Body() data: ChangePasswordDto) {
    return this.usersService.changePassword(id, data);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete user by ID' })
  @ApiParam({ name: 'id', description: 'User UUID' })
  @ApiResponse({ status: 200, description: 'User deleted successfully.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  async remove(@Param('id') id: string) {
    return this.usersService.remove(id);
  }

  @Get(':id/documents')
  @ApiOperation({ summary: 'List all uploaded documents for a specific student' })
  @ApiParam({ name: 'id', description: 'Student User UUID' })
  @ApiResponse({ status: 200, description: 'Returns array of student documents.' })
  @ApiResponse({ status: 404, description: 'Student user not found.' })
  async getStudentDocuments(@Param('id') id: string) {
    return this.usersService.getStudentDocuments(id);
  }

  @Get(':id/profile')
  @ApiOperation({ summary: 'Get consolidated unified JSON profile for a student' })
  @ApiParam({ name: 'id', description: 'Student User UUID' })
  @ApiResponse({ status: 200, description: 'Returns student unified profile.' })
  @ApiResponse({ status: 404, description: 'Student profile not found.' })
  async getStudentProfile(@Param('id') id: string) {
    return this.usersService.getStudentProfile(id);
  }
}
