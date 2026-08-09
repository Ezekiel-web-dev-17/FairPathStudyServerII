import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import {
  ArcjetGuard,
  ArcjetModule,
  detectBot,
  fixedWindow,
  shield,
} from '@arcjet/nest';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ArcjetModule.forRootAsync({
      isGlobal: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        key: configService.get<string>('ARCJET_KEY', ''),
        rules: [
          shield({ mode: 'LIVE' }),
          detectBot({
            mode: 'LIVE',
            allow: [
              'CATEGORY:SEARCH_ENGINE',
              'CURL', // Allow curl specifically while keeping detectBot in LIVE mode
            ],
          }),
          fixedWindow({
            mode: 'LIVE',
            window: '60s',
            max: 60, // Allow up to 60 requests per minute
          }),
        ],
      }),
    }),
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ArcjetGuard,
    },
  ],
})
export class AppModule {}
