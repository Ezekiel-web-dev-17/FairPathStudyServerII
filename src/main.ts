import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import morgan from 'morgan';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 1. Morgan - HTTP request logger middleware
  app.use(morgan('dev'));

  // 2. Helmet - Secure HTTP headers
  app.use(helmet());

  // 3. CORS - Enable Cross-Origin Resource Sharing
  app.enableCors({
    origin: '*', // Set specific origins in production, e.g., 'https://yourdomain.com'
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  // Retrieve ConfigService from Nest app container
  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 4000);

  await app.listen(port);
}
bootstrap();
