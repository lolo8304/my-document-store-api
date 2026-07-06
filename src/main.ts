import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  app.enableCors({
    origin: config.get<string>('APP_CORS_ORIGIN') ?? 'http://localhost:3001',
  });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('my-document-store API')
    .setDescription('REST API for OCR indexing and searching Dropbox PDF documents.')
    .setVersion('0.1.0')
    .addApiKey({ type: 'apiKey', name: 'api_key', in: 'header' }, 'api_key')
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('swagger', app, swaggerDocument, {
    swaggerOptions: {
      persistAuthorization: true,
    },
  });

  await app.listen(config.get<number>('PORT') ?? 3000);
}

void bootstrap();
