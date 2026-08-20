import { NestFactory } from '@nestjs/core';
import { VersioningType } from '@nestjs/common';
import helmet from 'helmet';
import morgan from 'morgan';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
// If you are still using the Zod setup we discussed earlier:
// import { patchNestJsSwagger, cleanupOpenApiDoc } from 'nestjs-zod';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 1. Global Prefix and API Versioning (/api/v1/...)
  app.setGlobalPrefix('api');
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  // 2. Morgan - HTTP request logger middleware
  app.use(morgan('dev'));

  // 3. Helmet - Secure HTTP headers
  app.use(helmet());

  // 4. CORS - Enable Cross-Origin Resource Sharing
  app.enableCors({
    origin: '*', // Set specific origins in production, e.g., 'https://yourdomain.com'
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  // Zod specific patch (uncomment if you are using nestjs-zod)
  // patchNestJsSwagger();

  // 5. Configure the Swagger Document Builder
  const config = new DocumentBuilder()
    .setTitle('My Backend API')
    .setDescription('The core API documentation for my application')
    .setVersion('1.0')
    // If you are using the JWT Auth we discussed earlier, enable this:
    // .addBearerAuth() 
    .build();

  // 6. Create the document object
  const document = SwaggerModule.createDocument(app, config);

  // 7. Setup the Swagger UI endpoint at /api/docs
  SwaggerModule.setup('api/docs', app, document); 
  // Or, if using Zod: SwaggerModule.setup('api/docs', app, cleanupOpenApiDoc(document));

  // Retrieve ConfigService from Nest app container
  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 4000);

  await app.listen(port);
}
bootstrap();
