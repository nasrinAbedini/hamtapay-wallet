import { Global, Module } from "@nestjs/common";
import { DataSource } from "typeorm";

@Global()
@Module({
  providers: [
    {
      provide: DataSource,
      useFactory: async () => {
        const source = new DataSource({
          type: "postgres",
          url:
            process.env.DATABASE_URL ??
            "postgres://wallet:wallet@localhost:5432/wallet",
          entities: [],
          migrations: [__dirname + "/migrations/*{.ts,.js}"],
          synchronize: false,
          logging: process.env.NODE_ENV === "development",
        });
        return source.initialize();
      },
    },
  ],
  exports: [DataSource],
})
export class DatabaseModule {}
