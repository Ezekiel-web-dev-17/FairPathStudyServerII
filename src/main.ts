import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import morgan from 'morgan';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
// If you are still using the Zod setup we discussed earlier:
// import { patchNestJsSwagger, cleanupOpenApiDoc } from 'nestjs-zod';

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

  // Zod specific patch (uncomment if you are using nestjs-zod)
  // patchNestJsSwagger();

  // 1. Configure the Swagger Document Builder
  const config = new DocumentBuilder()
    .setTitle('My Backend API')
    .setDescription('The core API documentation for my application')
    .setVersion('1.0')
    // If you are using the JWT Auth we discussed earlier, enable this:
    // .addBearerAuth() 
    .build();

  // 2. Create the document object
  const document = SwaggerModule.createDocument(app, config);

  // 3. Setup the Swagger UI endpoint
  // The first argument ('api') is the route path (e.g., localhost:3000/api)
  SwaggerModule.setup('api', app, document); 
  // Or, if using Zod: SwaggerModule.setup('api', app, cleanupOpenApiDoc(document));

  // Retrieve ConfigService from Nest app container
  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 4000);

  await app.listen(port);
}
bootstrap();
