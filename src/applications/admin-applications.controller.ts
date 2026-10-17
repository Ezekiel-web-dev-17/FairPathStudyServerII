import {
  Controller,
  Get,
  Query,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { WithArcjetRules, slidingWindow } from '@arcjet/nest';
import { ApplicationOrchestratorService } from './application-orchestrator.service.js';
import {
  GetBlockedApplicationsSchema,
  GetBlockedApplicationsDto,
  IPaginatedBlockedApplicationsResponse,
} from './applications.dto.js';
import { getArcjetMode } from '../config/arcjet.config.js';

@ApiTags('Admin Applications')
@Controller('admin/applications')
export class AdminApplicationsController {
  constructor(
    private readonly orchestratorService: ApplicationOrchestratorService,
  ) {}

  /**
   * GET /admin/applications/blocked
   * Returns a paginated list of all applications where status is SUBMISSION_FAILED_ADMIN_REVIEW.
   * Joins user name and institution name, highly optimized with selective column projection.
   */
  @Get('blocked')
  @WithArcjetRules([
    slidingWindow({
      mode: getArcjetMode(),
      interval: '1m',
      max: 30,
    }),
  ])
  @ApiOperation({
    summary: 'Retrieve paginated list of blocked applications requiring admin review',
    description:
      'Returns applications with status SUBMISSION_FAILED_ADMIN_REVIEW along with user and institution details. Optimized for large datasets.',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    example: 1,
    description: 'Page number (minimum: 1)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    example: 20,
    description: 'Items per page (1-100, default: 20)',
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated blocked applications retrieved successfully.',
  })
  @ApiResponse({ status: 400, description: 'Invalid pagination query parameters.' })
  async getBlockedApplications(
    @Query() query: GetBlockedApplicationsDto,
  ): Promise<IPaginatedBlockedApplicationsResponse> {
    const parseResult = GetBlockedApplicationsSchema.safeParse(query);
    if (!parseResult.success) {
      const messages = parseResult.error.issues
        ? parseResult.error.issues.map((e) => e.message).join(', ')
        : parseResult.error.message;
      throw new BadRequestException(messages);
    }

    const { page, limit } = parseResult.data;
    return this.orchestratorService.getBlockedApplications(page, limit);
  }
}
