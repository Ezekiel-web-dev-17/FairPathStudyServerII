import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiService } from './ai.service.js';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}
