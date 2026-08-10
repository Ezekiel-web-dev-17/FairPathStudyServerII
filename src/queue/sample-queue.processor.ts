import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

@Processor('sample-queue')
export class SampleQueueProcessor extends WorkerHost {
  private readonly logger = new Logger(SampleQueueProcessor.name);

  async process(job: Job<any, any, string>): Promise<any> {
    this.logger.log(
      `Processing job ${job.id} [${job.name}] with data: ${JSON.stringify(job.data)}`,
    );

    switch (job.name) {
      case 'example-job': {
        const result = {
          processedAt: new Date().toISOString(),
          payload: job.data,
        };
        this.logger.log(`Job ${job.id} completed successfully.`);
        return result;
      }
      default:
        this.logger.warn(`Unhandled job name: ${job.name}`);
        return { status: 'skipped' };
    }
  }
}
