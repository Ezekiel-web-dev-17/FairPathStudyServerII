import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AiModule } from '../ai/ai.module.js';
import { ScraperService, INSTITUTION_UPDATES_QUEUE } from './scraper.service.js';
import { ScraperController } from './scraper.controller.js';
import { InstitutionUpdatesProcessor } from './institution-updates.processor.js';

@Module({
  imports: [
    PrismaModule,
    AiModule,
    BullModule.registerQueue({
      name: INSTITUTION_UPDATES_QUEUE,
    }),
  ],
  controllers: [ScraperController],
  providers: [ScraperService, InstitutionUpdatesProcessor],
  exports: [ScraperService, BullModule],
})
export class ScraperModule {}
