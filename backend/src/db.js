import pg from "pg";
import fs from "fs";
import { cfg } from "./config.js";

export const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 20 });
export const q = (text, params) => pool.query(text, params);

export async function migrate() {
  const sql = fs.readFileSync(
    new URL("../schema.sql", import.meta.url),
    "utf8"
  );
  await pool.query(sql);
}
