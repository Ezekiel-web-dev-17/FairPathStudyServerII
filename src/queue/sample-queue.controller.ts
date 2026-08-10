import { Controller, Post, Body } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { SampleQueueService } from './sample-queue.service';

@ApiTags('Queue')
@Controller('queue')
export class SampleQueueController {
  constructor(private readonly sampleQueueService: SampleQueueService) {}

  @Post('sample')
  @ApiOperation({ summary: 'Enqueue a sample background job into BullMQ' })
  async enqueueSampleJob(@Body() body: Record<string, any>) {
    const payload = body && Object.keys(body).length > 0 ? body : { message: 'Hello BullMQ!' };
    return this.sampleQueueService.addExampleJob(payload);
  }
}
