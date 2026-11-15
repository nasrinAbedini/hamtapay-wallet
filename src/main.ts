import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  const swagger = new DocumentBuilder()
    .setTitle("Hamtapay Wallet API")
    .setVersion("1.0")
    .build();
  SwaggerModule.setup("docs", app, SwaggerModule.createDocument(app, swagger));
  await app.listen(Number(process.env.PORT ?? 3000));
}
void bootstrap();
