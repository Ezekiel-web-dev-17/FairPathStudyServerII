import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AiModule } from '../ai/ai.module.js';
import { ScraperService } from './scraper.service.js';
import { ScraperController } from './scraper.controller.js';

@Module({
  imports: [PrismaModule, AiModule],
  controllers: [ScraperController],
  providers: [ScraperService],
  exports: [ScraperService],
})
export class ScraperModule {}
