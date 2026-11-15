import "reflect-metadata";
import { DataSource } from "typeorm";
export default new DataSource({
  type: "postgres",
  url:
    process.env.DATABASE_URL ??
    "postgres://wallet:wallet@localhost:5432/wallet",
  entities: [],
  migrations: [__dirname + "/migrations/*{.ts,.js}"],
  synchronize: false,
});
