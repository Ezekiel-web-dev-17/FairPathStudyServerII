import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ApplicationOrchestratorService } from './application-orchestrator.service.js';
import { AdminApplicationsController } from './admin-applications.controller.js';
import { AUTO_APPLY_QUEUE } from './applications.dto.js';

@Module({
  imports: [
    PrismaModule,
    BullModule.registerQueue({
      name: AUTO_APPLY_QUEUE,
    }),
  ],
  controllers: [AdminApplicationsController],
  providers: [ApplicationOrchestratorService],
  exports: [ApplicationOrchestratorService, BullModule],
})
export class ApplicationsModule {}
