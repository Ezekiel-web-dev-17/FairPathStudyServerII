import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { BullModule } from '@nestjs/bullmq';
import {
  ArcjetGuard,
  ArcjetModule,
  detectBot,
  fixedWindow,
  shield,
} from '@arcjet/nest';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SampleQueueModule } from './queue/sample-queue.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { DocumentsModule } from './documents/documents.module.js';
import { OcrModule } from './ocr/ocr.module';
import { ScraperModule } from './scraper/scraper.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    PrismaModule,
    DocumentsModule,
    OcrModule,
    ScraperModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get<string>('REDIS_HOST', 'localhost'),
          port: configService.get<number>('REDIS_PORT', 6379),
          password:
            configService.get<string>('REDIS_PASSWORD', '') || undefined,
        },
      }),
    }),
    SampleQueueModule,
    ArcjetModule.forRootAsync({
      isGlobal: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const mode = configService.get<'LIVE' | 'DRY_RUN'>(
          'ARCJET_MODE',
          'DRY_RUN',
        );
        return {
          key: configService.get<string>('ARCJET_KEY', ''),
          rules: [
            shield({ mode }),
            detectBot({
              mode,
              allow: [
                'CATEGORY:SEARCH_ENGINE',
                'CURL', // Allow curl for API testing
              ],
            }),
            fixedWindow({
              mode,
              window: '60s',
              max: 60,
            }),
          ],
        };
      },
    }),
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // {
    //   provide: APP_GUARD,
    //   useClass: ArcjetGuard,
    // },
  ],
})
export class AppModule {}

