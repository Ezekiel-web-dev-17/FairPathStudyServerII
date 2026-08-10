import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { SampleQueueService } from './sample-queue.service';
import { SampleQueueProcessor } from './sample-queue.processor';
import { SampleQueueController } from './sample-queue.controller';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'sample-queue',
    }),
  ],
  controllers: [SampleQueueController],
  providers: [SampleQueueService, SampleQueueProcessor],
  exports: [SampleQueueService, BullModule],
})
export class SampleQueueModule {}
