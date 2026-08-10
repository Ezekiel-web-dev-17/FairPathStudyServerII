import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class SampleQueueService {
  private readonly logger = new Logger(SampleQueueService.name);

  constructor(
    @InjectQueue('sample-queue') private readonly sampleQueue: Queue,
  ) {}

  async addExampleJob(data: Record<string, any>) {
    this.logger.log(`Enqueueing job 'example-job' into sample-queue`);
    const job = await this.sampleQueue.add('example-job', data, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
    });

    return {
      jobId: job.id,
      name: job.name,
      status: 'enqueued',
    };
  }
}
